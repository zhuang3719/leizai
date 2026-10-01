'use strict';
/**
 * 雷仔 Pro · 激活链路（P-产品部署 步①）
 * ---------------------------------------------------------------------------
 * 职责：`licenseKey → POST /pro/verify {licenseKey, deviceId, product} → token`
 *       → 存 `<dataDir>/pro-token.json`（尽力 0600）→ 供 gate/proclient 注入私模。
 *   同端点重复调用即**心跳/续签**（服务端语义）。
 *
 * 铁律：
 *   1) **绝不 throw**——一律返回对象，异常即 `{ok:false,error}`。
 *   2) **token 不落仓**——只写本机 `<dataDir>`（运行时数据目录，已 gitignore）。
 *   3) 授权 token 格式「单一权威」= 两段式 `b64url(payload).b64url(sig)`（服务端签发，本模块只搬运不解析）。
 *
 * 依据：workspace/doc/产品部署-定案.md §1（① 激活链路端到端接通）。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DATA_DIR } = require('../config');

const DEFAULTS = {
  serverUrl: 'https://api.leizai.cc', // /pro/verify
  product: 'leizai',
  timeoutMs: 15000,
};

function _proCfg(cfg) {
  const p = (cfg && cfg.pro && typeof cfg.pro === 'object') ? cfg.pro : {};
  return { ...DEFAULTS, ...p };
}

/** token 文件路径：<dataDir>/pro-token.json（运行时数据目录，不入仓）。 */
function tokenPath() { return path.join(DATA_DIR, 'pro-token.json'); }

// —— P1-7 时钟回拨保护：单调钟 + 持久化高水位（回拨不延长离线窗口）——
//   performance.now() 单调（不受系统时钟调整影响）；跨进程/重启用持久化高水位 hw 兜底。
let _hw = 0;                 // 高水位：曾见过的最大有效时间（持久化于 token 文件）
let _monoBaseWall = 0;       // 单调钟基准（挂钟）
let _monoBasePerf = 0;
(function _initMono() {
  try { const j = JSON.parse(fs.readFileSync(tokenPath(), 'utf8')); if (Number.isFinite(j && j.hw)) _hw = Math.max(_hw, Number(j.hw)); } catch { /* 无 token 文件 */ }
  _monoBaseWall = Math.max(Date.now(), _hw);
  _monoBasePerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
})();
/** 单调推进的当前时间 = max(挂钟, 单调钟, 高水位)；系统时钟被回拨**不会**使其回退。 */
function effectiveNow() {
  const p = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  const mono = _monoBasePerf ? (_monoBaseWall + (p - _monoBasePerf)) : Date.now();
  const n = Math.max(Date.now(), mono, _hw);
  if (n > _hw) _hw = n;
  return n;
}

/** 稳定设备指纹（不含隐私明文）：hostname|platform|arch|user 的 sha256 前 32。 */
function deviceId() {
  try {
    const raw = [os.hostname(), os.platform(), os.arch(), (os.userInfo && os.userInfo().username) || ''].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  } catch { return 'unknown'; }
}

function readToken() {
  try {
    const j = JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
    if (Number.isFinite(j && j.hw)) _hw = Math.max(_hw, Number(j.hw));   // P1-7：读盘即抬升回拨高水位
    return (j && j.token) ? j : null;
  } catch { return null; }
}
function hasToken() { return !!readToken(); }

function saveToken(obj) {
  try {
    const p = tokenPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 尽力 0600（POSIX）；Windows 下 chmod 语义有限，仅作意图声明。
    fs.writeFileSync(p, JSON.stringify({ ...obj, hw: effectiveNow() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* Windows 忽略 */ }
    return true;
  } catch { return false; }
}

async function _post(url, payload, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
    return { status: r.status, body: j, raw: txt };
  } finally { clearTimeout(t); }
}

/**
 * 激活（或心跳续签）：licenseKey → /pro/verify → token → 落盘。**绝不 throw**。
 * @returns {Promise<{ok:boolean, tier?:string, exp?:number, deviceId?:string, saved?:boolean, error?:string, status?:number}>}
 */
async function activate(cfg, opts = {}) {
  try {
    const c = _proCfg(cfg);
    const key = String(opts.licenseKey || c.licenseKey || '').trim();
    if (!key) return { ok: false, error: 'missing_license_key', status: 400 };
    const url = String(c.serverUrl).replace(/\/+$/, '') + '/pro/verify';
    const payload = { licenseKey: key, deviceId: deviceId(), product: opts.product || c.product };
    const res = await _post(url, payload, c.timeoutMs);
    if (res.status !== 200 || !res.body || res.body.ok !== true || !res.body.token) {
      return { ok: false, error: (res.body && res.body.error) || ('http_' + res.status), status: res.status || 502 };
    }
    const rec = {
      token: res.body.token,
      tier: res.body.tier || 'pro',
      product: res.body.product || c.product,
      lic: res.body.lic || key,
      exp: res.body.exp || null,
      maxOfflineMs: res.body.maxOfflineMs || null,
      deviceId: payload.deviceId,
      activatedAt: Date.now(),
      onlineAt: effectiveNow(),          // P1-7：最近一次“在线”时间（单调钟），离线窗口从此起算
      serverTime: res.body.serverTime || null,
    };
    if (Number(res.body.serverTime) > _hw) _hw = Number(res.body.serverTime);   // 服务端时间为权威锚点
    const saved = saveToken(rec);
    return { ok: saved, tier: rec.tier, exp: rec.exp, deviceId: rec.deviceId, saved };
  } catch (e) {
    return { ok: false, error: 'activate_error:' + ((e && e.message) || e) };
  }
}

/** 心跳/续签：复用已存 licenseKey 再调 /pro/verify。 */
async function heartbeat(cfg) {
  const t = readToken();
  if (!t) return { ok: false, error: 'no_token' };
  return activate(cfg, { licenseKey: t.lic });
}

function clearToken() { try { fs.rmSync(tokenPath(), { force: true }); return true; } catch { return false; } }

/** 本地状态（不联网）：token 有效性 = 未过期 + 在离线窗口内；全程用单调钟，回拨不延长窗口。 */
function status() {
  const t = readToken();
  if (!t) return { activated: false, tier: 'lite', reason: 'no-token' };
  const now = effectiveNow();
  const exp = Number(t.exp) || 0;
  const onlineAt = Number(t.onlineAt || t.activatedAt) || now;
  const offlineMs = Math.max(0, now - onlineAt);
  const maxOfflineMs = Number(t.maxOfflineMs) || (72 * 60 * 60 * 1000);
  const base = { exp, offlineMs, maxOfflineMs, deviceId: t.deviceId, lic: t.lic };
  if (exp && now > exp) return { ...base, activated: false, tier: 'lite', reason: 'token-expired' };
  if (maxOfflineMs > 0 && offlineMs > maxOfflineMs) return { ...base, activated: false, tier: 'lite', reason: 'offline-window-exceeded' };
  return { ...base, activated: true, tier: t.tier || 'pro' };
}
/** P1-7：token 是否有效（供 gate enforce 判定；不再只看“文件存在”）。 */
function isValid() { return status().activated === true; }

module.exports = { activate, heartbeat, clearToken, status, isValid, hasToken, readToken, deviceId, tokenPath, effectiveNow, DEFAULTS };
