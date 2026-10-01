'use strict';
/**
 * 雷仔 · Pro 能力门禁（soft-gate）契约 + 开源 stub
 * ---------------------------------------------------------------------------
 * 铁律：
 *   1) **绝不 throw**——任何异常一律降级返回（可用性优先），绝不因门禁把引擎搞崩。
 *   2) **默认开发放行**——无 pro 私模 / 未激活 license 时，默认按 Pro 放行（devAllowAll）。
 *      只有显式 `pro.devAllowAll=false` 或 `pro.enforce=true` 才进入 Lite 限制态。
 *      → 保证"未配 license 也不会导致启动失败或功能被限"。
 *   3) 本文件为**开源 stub**：真正的硬 gate 在闭源私模 `pro/leizai-pro.exe`（P3-b），
 *      本 stub 只做"档位判定 + Lite 配额"这一层，且可被开源用户按需替换。
 *
 * 契约：checkPro(cap, ctx) -> { allow, tier:'lite'|'pro', reason, quota }
 *   - allow : 是否放行到 **Pro 额度**（false=改按 quota 限；基础能力仍可用）
 *   - quota : Lite 态下该能力的上限（allow=true 时为 null）
 *
 * 依据：workspace/doc/P3-Pro硬防护-定案.md §1/§2（方案 B：独立子进程 + soft-gate）
 */

/** Lite 档能力上限（引用《档位体系-最终方案.md》口径：Lite=单agent核心+限次多角色+有限记忆） */
const LITE_QUOTA = {
  'multi-agent': { maxRoles: 1, maxConcurrent: 1 },  // 多角色/派单协作 → 限 1
  evolution: { mode: 'off' },                        // 自我进化 → 关闭
  memory: { max: 150 },                              // 记忆 → 有限条数
  skill: { max: 50 },                                // 技能 → 有限条数
  selftrain: { mode: 'off' },                        // 自训练 → 关闭
};

const DEFAULTS = {
  devAllowAll: true,                 // ★开发兜底：默认放行（真实部署时显式设 false）
  enforce: false,                    // true=严格（异常→Lite）；false=可用性优先（异常→Pro）
  serverUrl: 'https://api.leizai.cc',// P2 服务端（/pro/verify）
  licenseKey: '',                    // 由客户端/壳注入（不落明文仓）
  deviceId: '',                      // 机器指纹
  proModule: '',                     // 私模路径（缺省 pro/leizai-pro.exe）
};

// 运行态（init 前默认 Pro：绝不在启动早期限制功能）
let _state = { tier: 'pro', reason: 'pre-init', enabled: false };

function _envDev() { return process.env.LEIZAI_PRO_DEV === '1'; }

function _normalizePro(cfg) {
  const p = (cfg && cfg.pro && typeof cfg.pro === 'object') ? cfg.pro : {};
  return { ...DEFAULTS, ...p };
}

function _resolveMode(cfg) {
  const p = _normalizePro(cfg);
  if (_envDev()) return 'dev';
  if (p.devAllowAll === false || p.enforce === true) return 'enforce';
  return 'dev'; // 默认 dev（不锁死）
}

/**
 * 初始化档位（由 server.js 启动门调用）。**绝不 throw**。
 * @returns {{tier,reason,enabled}}
 */
function init(cfg) {
  try {
    const mode = _resolveMode(cfg);
    if (mode === 'dev') {
      _state = { tier: 'pro', reason: _envDev() ? 'dev-env' : 'dev-allow-all', enabled: true };
    } else {
      // 强制态：先做【完整性互校】（P3-c）。验签/互校不一致 → 降级 Lite（绝不崩）。
      // 仅当显式 pro.integrity === 'off' 才跳过。
      const _p = _normalizePro(cfg);
      if (_p.integrity !== 'off') {
        let iv;
        try { iv = require('./integrity').startupCheck(cfg); }
        catch (e) { iv = { ok: false, reason: 'integrity-error:' + (e && e.message || e) }; }
        if (!iv || iv.ok !== true) {
          _state = { tier: 'lite', reason: 'integrity-fail:' + ((iv && iv.reason) || 'unknown'), enabled: false };
          return { ..._state };
        }
      }
      // 再判私模是否就位。缺私模 → Lite（绝不崩）。
      // 就位 → 先按 Lite，后台握手成功再升级 Pro（P3-b；握手失败保持 Lite）。
      // enforce：**有授权 token 才 probe 私模**；无 token → Lite（绝不 throw / 绝不锁死）。
      let hasLic = false;
      try { hasLic = require('./activate').hasToken(); } catch { hasLic = false; }
      let exe = '';
      try { exe = require('./proclient').resolveProExe(cfg); } catch { exe = ''; }
      if (!hasLic) {
        _state = { tier: 'lite', reason: 'no-license(enforce)', enabled: false };
      } else if (!exe || !require('node:fs').existsSync(exe)) {
        _state = { tier: 'lite', reason: 'no-pro-module(enforce)', enabled: false };
      } else {
        _state = { tier: 'lite', reason: 'pro-handshake-pending', enabled: false };
        try { probeModule(cfg, exe); } catch { }
      }
    }
  } catch (e) {
    _state = { tier: 'pro', reason: 'init-error(fail-safe):' + (e && e.message || e), enabled: false };
  }
  return { ..._state };
}

function getState() { return { ..._state }; }
function isPro() { return _state.tier === 'pro'; }

/** 私模客户端单例（仅供高级用途/调试；正常判定走 check/checkPro） */
let _client = null;
function getClient() { return _client; }

/**
 * 后台拉起私模并握手（P3-b）。成功 → 升级 Pro；失败/超时 → 保持 Lite。**绝不 throw**。
 * @param {object} cfg
 * @param {string} exe
 */
async function probeModule(cfg, exe) {
  try {
    if (_client && _client.available) return true;
    const { ProClient } = require('./proclient');
    let _lic = '';
    try { const tr = require('./activate').readToken(); _lic = (tr && tr.token) || ''; } catch { _lic = ''; }
    const c = new ProClient(exe, { timeoutMs: 5000, license: _lic });
    const ok = await c.start();
    if (ok) { _client = c; _state = { tier: 'pro', reason: 'pro-module-ok', enabled: true }; }
    else { try { c.stop(); } catch { } _state = { tier: 'lite', reason: 'pro-module-unavailable:' + (c.lastError || ''), enabled: false }; }
    return ok;
  } catch (e) {
    _state = { tier: 'lite', reason: 'pro-module-error:' + (e && e.message), enabled: false };
    return false;
  }
}

function _decide(cap) {
  // 已判定 Pro / 或早于 init（pre-init）→ 放行
  if (_state.tier === 'pro') {
    return { allow: true, tier: 'pro', reason: _state.reason, quota: null };
  }
  // Lite：非能力名放行；能力名按 quota 限
  if (!cap) return { allow: true, tier: 'lite', reason: _state.reason, quota: null };
  return { allow: false, tier: 'lite', reason: _state.reason, quota: LITE_QUOTA[cap] || null };
}

/** 同步判定（供同步调用点使用，如 evolution.propose / memory.save / skills.savePackage） */
function check(cap, ctx = {}) { // eslint-disable-line no-unused-vars
  try {
    return _decide(cap);
  } catch (e) {
    return _failSafe(cap, e);
  }
}

/** 异步判定（供 async 调用点使用，如 tools.exec / subagent.spawn） */
async function checkPro(cap, ctx = {}) { // eslint-disable-line no-unused-vars
  try {
    return _decide(cap);
  } catch (e) {
    return _failSafe(cap, e);
  }
}

function _failSafe(cap, e) {
  // 强制态 → Lite（不误放行）；其余 → Pro（可用性优先，绝不锁死）
  const strict = _state && typeof _state.reason === 'string' && _state.reason.startsWith('no-license');
  if (strict) return { allow: false, tier: 'lite', reason: 'gate-error(fail-safe-lite):' + (e && e.message || e), quota: LITE_QUOTA[cap] || null };
  return { allow: true, tier: 'pro', reason: 'gate-error(fail-safe-pro):' + (e && e.message || e), quota: null };
}

module.exports = { init, checkPro, check, getState, isPro, LITE_QUOTA, DEFAULTS, probeModule, getClient };
