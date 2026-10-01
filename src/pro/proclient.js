'use strict';
/**
 * 雷仔 · Pro 私模客户端（P3-b · 引擎侧）
 * ---------------------------------------------------------------------------
 * 职责：按 gate.js 契约，把「Pro 硬 gate」下沉到闭源私模子进程
 *   `pro/leizai-pro.exe`（NativeAOT 编译；源码在 src-pro/，**绝不进开源仓**）。
 *
 * 传输：stdio **长度前缀 JSON-RPC** —— 每帧 = 4 字节大端 uint32 长度 + UTF-8 JSON。
 * 安全：Node 生成**一次性 PRO_TOKEN**（crypto.randomBytes），经 handshake 帧 + env PRO_TOKEN
 *       双路送给私模，私模校验后才响应（防本机其它进程顶替）。
 *
 * 铁律：
 *   - **缺 exe / 握手失败 / 任何异常 → 一律视为"私模不可用"**，由调用方降级 Lite，**绝不 throw 到引擎**。
 *   - token 格式（与 P2 服务端对齐）：**两段式** `b64url(payload).b64url(sig)`（单一权威见
 *     license-server/src/pro/verify.js 头部声明）。本客户端只透传，不自行验签（验签在私模内）。
 *
 * 依据：workspace/doc/P3-Pro硬防护-定案.md §1（方案 B：独立子进程 + JSON-RPC + 一次性 PRO_TOKEN）
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROTO_VERSION = 'p3b-1';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 解析私模路径：config.pro.proModule > env LEIZAI_PRO_MODULE > <ROOT>/pro/leizai-pro.exe */
function resolveProExe(cfg) {
  try {
    const p = (cfg && cfg.pro) || {};
    if (p.proModule && String(p.proModule).trim()) return path.resolve(String(p.proModule).trim());
    if (process.env.LEIZAI_PRO_MODULE) return path.resolve(process.env.LEIZAI_PRO_MODULE);
    const root = path.resolve(__dirname, '..', '..');
    return path.join(root, 'pro', process.platform === 'win32' ? 'leizai-pro.exe' : 'leizai-pro');
  } catch { return ''; }
}

class ProClient {
  constructor(exe, opts = {}) {
    this.exe = exe;
    this.args = Array.isArray(opts.args) ? opts.args.slice() : [];
    this.timeoutMs = num(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.token = crypto.randomBytes(32).toString('hex');   // 通道令牌（IPC 帧校验，一次性）
    this.license = String(opts.license || process.env.PRO_LICENSE || ''); // 授权令牌（/pro/verify 签发，供私模验签）
    this.proc = null;
    this._buf = Buffer.alloc(0);
    this._pending = new Map();
    this._seq = 1;
    this._ok = false;
    this._err = null;
  }

  get available() { return this._ok; }
  get lastError() { return this._err; }

  /** 拉起私模 + 握手。任何失败 → 返回 false（不抛）。 */
  async start() {
    try {
      if (!this.exe || !fs.existsSync(this.exe)) { this._err = 'exe_not_found'; return false; }
      this.proc = spawn(this.exe, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PRO_TOKEN: this.token, ...(this.license ? { PRO_LICENSE: this.license } : {}) },
      });
      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.on('data', (d) => { try { console.error('[pro-module]', String(d).trim()); } catch { } });
      this.proc.on('error', (e) => { this._err = 'spawn_error:' + (e && e.message); this._ok = false; });
      this.proc.on('exit', (code) => { this._ok = false; this._err = 'exited:' + code; for (const [, p] of this._pending) p.reject(new Error('pro_module_exited')); this._pending.clear(); });

      const r = await this._send('handshake', { token: this.token, license: this.license, version: PROTO_VERSION });
      this._ok = !!(r && r.ok);
      this._err = this._ok ? null : 'handshake_rejected';
      return this._ok;
    } catch (e) {
      this._ok = false; this._err = 'start_failed:' + (e && e.message);
      this._kill();
      return false;
    }
  }

  /** 调私模方法；不可用/超时 → 返回 null（调用方降级）。 */
  async call(method, params) {
    if (!this._ok) return null;
    try { return await this._send(method, params); }
    catch (e) { this._err = 'call_failed:' + (e && e.message); return null; }
  }

  /** 询问某能力的放行决定（契约同 gate.checkPro）。 */
  async check(cap, ctx) {
    const r = await this.call('pro.check', { cap, ctx: ctx || {} });
    return (r && typeof r === 'object') ? r : null;
  }

  stop() { this._kill(); }

  _kill() {
    try { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); } } catch { }
    this.proc = null; this._ok = false;
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('not_started'));
      const id = this._seq++;
      const t = setTimeout(() => { this._pending.delete(id); reject(new Error('timeout')); }, this.timeoutMs);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      try { this.proc.stdin.write(frame({ jsonrpc: '2.0', id, method, params: params || {} })); }
      catch (e) { clearTimeout(t); this._pending.delete(id); reject(e); }
    });
  }

  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    // 拆帧：4 字节长度 + body
    while (this._buf.length >= 4) {
      const len = this._buf.readUInt32BE(0);
      if (len <= 0 || len > MAX_FRAME_BYTES) { this._buf = Buffer.alloc(0); this._err = 'bad_frame'; break; }
      if (this._buf.length < 4 + len) break;
      const body = this._buf.subarray(4, 4 + len).toString('utf8');
      this._buf = this._buf.subarray(4 + len);
      let msg = null;
      try { msg = JSON.parse(body); } catch { continue; }
      const p = this._pending.get(msg && msg.id);
      if (p) { this._pending.delete(msg.id); if (msg.error) p.reject(new Error(String(msg.error && msg.error.message || msg.error))); else p.resolve(msg.result); }
    }
  }
}

/** 组帧：4 字节大端长度 + UTF-8 JSON。 */
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function num(v, dflt) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : dflt; }

module.exports = { ProClient, resolveProExe, frame, PROTO_VERSION };
