'use strict';
/**
 * 雷仔 Pro · 授权心跳/续签（P1-5 c）
 * ---------------------------------------------------------------------------
 * 职责：进程内周期调用 `/pro/verify`（复用 `activate.heartbeat`）→ 服务端续签 token、
 *       更新 `<dataDir>/pro-token.json` 的 onlineAt（离线窗口起点）。
 *   - **绝不 throw / 绝不阻塞启动**：定时器 unref；网络失败仅记日志，由 gate/activate 的
 *     `maxOfflineMs`（默认 72h）兜底 → 到点自动降级 Lite。
 *   - 无 token / 显式 `pro.heartbeat === false` → 不启动。
 *
 * 依据：workspace/doc/产品开卖前必修清单-定案.md P1-5（心跳/续费 + 离线窗口到点降级）。
 */
const activate = require('./activate');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h（远小于 72h 离线窗口）
const STARTUP_DELAY_MS = 30 * 1000;             // 启动 30s 后轻量心跳一次

let _timer = null;
let _bootTimer = null;
let _last = null;

/** 执行一次心跳/续签（供定时器与测试复用）。**绝不 throw**。 */
async function tick(cfg) {
  let r;
  try { r = await activate.heartbeat(cfg); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  _last = { at: Date.now(), ok: !!(r && r.ok), error: (r && r.error) || null };
  if (_last.ok) {
    // 续签成功 → 让 gate 即时重判（离线窗口归零；保持既有 Pro 档位）
    try { require('./gate').revalidate(cfg); } catch { /* 重判失败无碍 */ }
  } else {
    // 续签失败 → 仍重判：若离线窗口已到点 → 立即降级 Lite（P1-5c 到点降级）
    try { require('./gate').revalidate(cfg); } catch { /* 无碍 */ }
    try { console.warn('[pro-heartbeat] renew failed: ' + (_last.error || 'unknown') + '（离线窗口内可继续，到点降级 Lite）'); } catch { }
  }
  return r;
}

/**
 * 启动周期心跳。**绝不 throw**。
 * @param {object} cfg 引擎配置
 * @returns {{ok:boolean, intervalMs?:number, reason?:string}}
 */
function start(cfg) {
  try {
    const p = (cfg && cfg.pro && typeof cfg.pro === 'object') ? cfg.pro : {};
    if (p.heartbeat === false) return { ok: false, reason: 'disabled' };
    let has = false; try { has = activate.hasToken(); } catch { has = false; }
    if (!has) return { ok: false, reason: 'no-token' };
    stop();
    const intervalMs = Math.max(60000, Number(p.heartbeatMs) || DEFAULT_INTERVAL_MS);
    _timer = setInterval(() => { tick(cfg); }, intervalMs);
    if (_timer.unref) _timer.unref();
    _bootTimer = setTimeout(() => { tick(cfg); }, STARTUP_DELAY_MS);
    if (_bootTimer.unref) _bootTimer.unref();
    return { ok: true, intervalMs };
  } catch (e) { return { ok: false, reason: 'start-error:' + ((e && e.message) || e) }; }
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
}

function lastResult() { return _last; }

module.exports = { start, stop, tick, lastResult, DEFAULT_INTERVAL_MS };
