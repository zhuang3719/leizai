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

/** 稳定设备指纹（不含隐私明文）：hostname|platform|arch|user 的 sha256 前 32。 */
function deviceId() {
  try {
    const raw = [os.hostname(), os.platform(), os.arch(), (os.userInfo && os.userInfo().username) || ''].join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  } catch { return 'unknown'; }
}

function readToken() {
  try { const j = JSON.parse(fs.readFileSync(tokenPath(), 'utf8')); return (j && j.token) ? j : null; }
  catch { return null; }
}
function hasToken() { return !!readToken(); }

function saveToken(obj) {
  try {
    const p = tokenPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 尽力 0600（POSIX）；Windows 下 chmod 语义有限，仅作意图声明。
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
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
      serverTime: res.body.serverTime || null,
    };
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

/** 本地状态（不联网）：是否已激活 + 档位。 */
function status() {
  const t = readToken();
  if (!t) return { activated: false, tier: 'lite' };
  const expired = t.exp ? Date.now() > t.exp : false;
  return { activated: !expired, tier: expired ? 'lite' : (t.tier || 'pro'), exp: t.exp, deviceId: t.deviceId, lic: t.lic };
}

module.exports = { activate, heartbeat, clearToken, status, hasToken, readToken, deviceId, tokenPath, DEFAULTS };
