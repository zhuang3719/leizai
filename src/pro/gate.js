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
  devAllowAll: false,                // ★P0-1 安全默认：不显式设 true 即 enforce（无 license → Lite）。开发实例须显式开。
  enforce: false,                    // true=显式强制（异常→Lite）；与 devAllowAll 互斥时优先 enforce
  serverUrl: 'https://api.leizai.cc',// P2 服务端（/pro/verify）
  licenseKey: '',                    // 由客户端/壳注入（不落明文仓）
  deviceId: '',                      // 机器指纹
  proModule: '',                     // 私模路径（缺省 pro/leizai-pro.exe）
};

// 运行态（P0-1：init 前默认 Lite —— 安全默认；绝不因"还没 init"就全放行）
let _state = { tier: 'lite', reason: 'pre-init', enabled: false };
let _mode = 'enforce';   // 由 init 解析；默认 enforce（安全）
let _inited = false;
const _CAP_TTL_MS = 30 * 1000;      // P0-1②：私模权威结论缓存 TTL
const _capCache = new Map();

function _envDev() { return process.env.LEIZAI_PRO_DEV === '1'; }

function _normalizePro(cfg) {
  const p = (cfg && cfg.pro && typeof cfg.pro === 'object') ? cfg.pro : {};
  return { ...DEFAULTS, ...p };
}

function _resolveMode(cfg) {
  const p = _normalizePro(cfg);
  if (_envDev()) return 'dev';                 // 显式逃生阀：LEIZAI_PRO_DEV=1
  if (p.enforce === true) return 'enforce';    // 显式强制（优先）
  if (p.devAllowAll === true) return 'dev';    // 显式开发放行（必须显式配置，不设即安全）
  return 'enforce';                            // ★P0-1 默认安全：无 license → Lite
}

/**
 * 初始化档位（由 server.js 启动门调用）。**绝不 throw**。
 * @returns {{tier,reason,enabled}}
 */
function init(cfg) {
  try {
    const mode = _resolveMode(cfg);
    _mode = mode;                                  // P0-1：记录模式，供 _failSafe / init 兜底判定
    _inited = true;                                // ★必须早置位：否则早退分支会让 check() 用真实配置再 init 一次，覆盖显式判定
    // P1-8：完整性互校**不再因 dev 模式跳过**；enforce 态**强制**（不可被 pro.integrity='off' 绕过），失败 → 降级 Lite。
    const _p = _normalizePro(cfg);
    if (_p.integrity !== 'off' || mode === 'enforce') {
      let iv;
      try { iv = require('./integrity').startupCheck(cfg); }
      catch (e) { iv = { ok: false, reason: 'integrity-error:' + (e && e.message || e) }; }
      if (!iv || iv.ok !== true) {
        if (mode === 'enforce') {
          _state = { tier: 'lite', reason: 'integrity-fail:' + ((iv && iv.reason) || 'unknown'), enabled: false };
          return { ..._state };   // 强制态：完整性失败 → 不授予 Pro（降级 Lite；绝不崩）
        }
        try { console.warn('[pro-gate] integrity warn(dev, non-fatal): ' + ((iv && iv.reason) || 'unknown')); } catch { }
      }
    }
    if (mode === 'dev') {
      _state = { tier: 'pro', reason: _envDev() ? 'dev-env' : 'dev-allow-all', enabled: true };
    } else {
      // 再判私模是否就位。缺私模 → Lite（绝不崩）。
      // 就位 → 先按 Lite，后台握手成功再升级 Pro（P3-b；握手失败保持 Lite）。
      // enforce：**必须有“有效”授权**（本地校验后的 exp + 离线窗口，含 P1-7 回拨保护）才 probe 私模；无效 → Lite。
      let av = { activated: false, reason: 'unknown' };
      try { av = require('./activate').status(); } catch (e) { av = { activated: false, reason: 'activate-error' }; }
      const hasLic = av.activated === true;
      let exe = '';
      try { exe = require('./proclient').resolveProExe(cfg); } catch { exe = ''; }
      if (!hasLic) {
        _state = { tier: 'lite', reason: 'no-license(enforce):' + (av.reason || ''), enabled: false };
      } else if (!exe || !require('node:fs').existsSync(exe)) {
        _state = { tier: 'lite', reason: 'no-pro-module(enforce)', enabled: false };
      } else {
        _state = { tier: 'lite', reason: 'pro-handshake-pending', enabled: false };
        try { probeModule(cfg, exe); } catch { }
      }
    }
  } catch (e) {
    // P0-1：init 异常也**绝不默认放行** —— enforce 态落 Lite；仅 dev 态保持放行
    _state = (_mode === 'enforce')
      ? { tier: 'lite', reason: 'init-error(fail-safe-lite):' + (e && e.message || e), enabled: false }
      : { tier: 'pro', reason: 'init-error(dev):' + (e && e.message || e), enabled: false };
  }
  _inited = true;
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

/** 惰性 init：未显式 init 时按本机配置判定一次（安全默认 enforce）。绝不 throw。 */
function _ensureInit() {
  if (_inited) return;
  try { init(require('../config').load()); } catch (e) { _mode = 'enforce'; _state = { tier: 'lite', reason: 'lazy-init-error(fail-safe-lite):' + (e && e.message || e), enabled: false }; _inited = true; }
}

/** 同步判定（供同步调用点使用，如 evolution.propose / memory.save / skills.savePackage） */
function check(cap, ctx = {}) { // eslint-disable-line no-unused-vars
  try {
    _ensureInit();
    return _decide(cap);
  } catch (e) {
    return _failSafe(cap, e);
  }
}

/** 同步判定 + 私模权威复核（P0-1②）。env/同步路径无法等待 RPC 时退回本地判定。 */
function _decideLocal(cap) { _ensureInit(); return _decide(cap); }

/**
 * 异步判定（供 async 调用点使用，如 tools.exec / subagent.spawn）。
 * P0-1②：判定**下沉闭源私模** —— tier=pro 时向 `pro/leizai-pro.exe` 求 `pro.check` 权威结论；
 *   私模不可用/超时/报错 → 一律回落 **Lite（fail-safe）**。结果按 cap 缓存 30s。
 */
async function checkPro(cap, ctx = {}) { // eslint-disable-line no-unused-vars
  try {
    _ensureInit();
    const local = _decide(cap);
    if (_mode !== 'enforce') return local;             // dev 态：本地放行（不打扰私模）
    if (!cap) return local;
    const now = Date.now();
    const hit = _capCache.get(cap);
    if (hit && (now - hit.at) < _CAP_TTL_MS) return hit.val;
    // 需要私模权威（tier=pro 才可能 allow）
    if (_state.tier !== 'pro' || !_client || !_client.available) {
      const deny = { allow: false, tier: 'lite', reason: 'gate-authority-unavailable:' + _state.reason, quota: LITE_QUOTA[cap] || null };
      _capCache.set(cap, { at: now, val: deny });
      return deny;
    }
    let r;
    try { r = await _client.call('pro.check', { cap, ctx }); }
    catch (e) { r = null; }
    const val = (r && typeof r.allow === 'boolean')
      ? { allow: !!r.allow, tier: r.tier || 'pro', reason: r.reason || 'pro-module', quota: r.quota || null }
      : { allow: false, tier: 'lite', reason: 'gate-authority-error(fail-safe-lite)', quota: LITE_QUOTA[cap] || null };
    _capCache.set(cap, { at: now, val });
    return val;
  } catch (e) {
    return _failSafe(cap, e);
  }
}

function _failSafe(cap, e) {
  // P0-1：enforce 态异常**绝不默认放行** → Lite；dev 态才放行（可控开发放行）
  if (_mode === 'enforce') {
    return { allow: false, tier: 'lite', reason: 'gate-error(fail-safe-lite):' + (e && e.message || e), quota: LITE_QUOTA[cap] || null };
  }
  return { allow: true, tier: 'pro', reason: 'gate-error(fail-safe-dev):' + (e && e.message || e), quota: null };
}

/**
 * 只按【当前授权有效性】重判档位（心跳后调用，P1-5c/P1-7）：无效 → Lite；有效则不动（保持既有已握手档位）。
 * 与 init 的区别：不重跑完整性/不重新 probe 私模（避免每 6h 抖动）。**绝不 throw**。
 */
function revalidate(cfg) { // eslint-disable-line no-unused-vars
  try {
    if (_mode !== 'enforce') return { ..._state };
    let av = { activated: false, reason: 'unknown' };
    try { av = require('./activate').status(); } catch (e) { av = { activated: false, reason: 'activate-error' }; }
    if (av.activated !== true) {
      _state = { tier: 'lite', reason: 'no-license(enforce):' + (av.reason || ''), enabled: false };
    }
    return { ..._state };
  } catch { return { ..._state }; }
}

module.exports = { init, refresh: init, revalidate, checkPro, check, getState, isPro, LITE_QUOTA, DEFAULTS, probeModule, getClient };
