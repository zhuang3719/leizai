'use strict';
/**
 * 雷仔 · Pro 完整性互校（P3-c）
 * ---------------------------------------------------------------------------
 * 职责：加载 `pro/manifest.json`（Ed25519 签名 + 受保护文件 sha256 清单），
 *       启动时【验签 + 逐文件 hash 互校】；不一致 → 返回 ok:false（调用方降级 Lite，绝不 crash）。
 *
 * 铁律：
 *   1) **绝不 throw**——任何异常一律返回 `{ok:false, reason}`。
 *   2) **只用公钥**（`pro/manifest.pub` 或 env `LEIZAI_PRO_PUBKEY`）验签；**私钥绝不在此/不落仓**。
 *   3) manifest 与公钥可入仓/随包；被篡改 → 检出。
 *
 * 依据：workspace/doc/P3-Pro硬防护-定案.md §1/§4（P3-c manifest 签名脚本 + 启动互校 + 降级）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 签名覆盖字段的【稳定序列化】（顺序固定；不含 signature 本身） */
function canonical(m) {
  return JSON.stringify({
    schema: m.schema,
    algo: m.algo,
    sig_algo: m.sig_algo,
    version: m.version,
    generatedAt: m.generatedAt,
    files: m.files,
  });
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function _root(opts) {
  if (opts && opts.root) return path.resolve(opts.root);
  if (process.env.LEIZAI_ROOT) return path.resolve(process.env.LEIZAI_ROOT);
  return path.resolve(__dirname, '..', '..');
}

/** 读公钥（base64 SPKI DER）：env > pro/manifest.pub > manifest 内嵌 */
function _readPubkey(root, manifest, manifestPath) {
  if (process.env.LEIZAI_PRO_PUBKEY && process.env.LEIZAI_PRO_PUBKEY.trim()) {
    return process.env.LEIZAI_PRO_PUBKEY.trim();
  }
  const pubFile = path.join(path.dirname(manifestPath), 'manifest.pub');
  if (fs.existsSync(pubFile)) {
    const s = fs.readFileSync(pubFile, 'utf8').trim();
    if (s) return s;
  }
  if (manifest && manifest.pubkey_spki_b64) return manifest.pubkey_spki_b64;
  return '';
}

/**
 * 执行验签 + 互校。**绝不 throw**。
 * @param {object} [opts] { root, manifestPath, logger }
 * @returns {{ok:boolean,reason:string,sigOk:(boolean|null),manifestOk:(boolean|null),
 *            tampered:Array,missing:Array,checked:number}}
 */
function verifyIntegrity(opts = {}) {
  const out = { ok: false, reason: '', sigOk: null, manifestOk: null, tampered: [], missing: [], checked: 0 };
  try {
    const root = _root(opts);
    const manifestPath = opts.manifestPath || path.join(root, 'pro', 'manifest.json');
    if (!fs.existsSync(manifestPath)) { out.reason = 'manifest-missing'; return out; }

    let m;
    try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { out.reason = 'manifest-parse-error'; return out; }
    if (!m || !Array.isArray(m.files) || !m.signature) { out.reason = 'manifest-incomplete'; return out; }

    const pubB64 = _readPubkey(root, m, manifestPath);
    if (!pubB64) { out.reason = 'pubkey-missing'; return out; }

    // 1) 验签（Ed25519）
    let pub;
    try { pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' }); }
    catch (e) { out.reason = 'pubkey-invalid'; return out; }
    out.sigOk = crypto.verify(null, Buffer.from(canonical(m), 'utf8'), pub, Buffer.from(m.signature, 'base64'));
    if (!out.sigOk) { out.reason = 'signature-invalid'; return out; }

    // 2) 逐文件 hash 互校
    for (const f of m.files) {
      const abs = path.join(root, String(f.path));
      out.checked++;
      if (!fs.existsSync(abs)) { out.missing.push(f.path); continue; }
      let actual;
      try { actual = sha256File(abs); } catch (e) { out.missing.push(f.path); continue; }
      if (actual !== f.sha256) out.tampered.push({ path: f.path, expect: f.sha256, actual });
    }
    out.manifestOk = out.missing.length === 0 && out.tampered.length === 0;
    out.ok = out.sigOk === true && out.manifestOk === true;
    out.reason = out.ok ? 'integrity-ok' : 'file-mismatch';
    return out;
  } catch (e) {
    out.reason = 'integrity-error:' + (e && e.message ? e.message : String(e));
    return out;
  }
}

/**
 * 启动互校（供 gate.init 调用）：失败写告警，返回 verdict。**绝不 throw**。
 * @param {object} [cfg] 配置（预留）
 */
function startupCheck(cfg) { // eslint-disable-line no-unused-vars
  const v = verifyIntegrity({});
  try {
    if (v.ok) {
      console.log('[pro-integrity] OK · 受保护文件 ' + v.checked + ' 项校验通过');
    } else {
      const detail = []
        .concat(v.tampered.map((t) => t.path))
        .concat(v.missing.map((p) => p + '(missing)'));
      console.warn('[pro-integrity] 校验未通过 → 降级 Lite · reason=' + v.reason +
        (detail.length ? ' · 异常项[' + detail.length + ']: ' + detail.join(', ') : ''));
      if (v.tampered.length) console.warn('[pro-integrity] tampered=' + JSON.stringify(v.tampered));
    }
  } catch (e) { /* 日志失败不影响返回 */ }
  return v;
}

module.exports = { verifyIntegrity, startupCheck, canonical, sha256File, _readPubkey };
