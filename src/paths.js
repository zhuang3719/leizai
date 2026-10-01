'use strict';
// 雷仔 · 数据路径（Node 侧）。优先读 env LEIZAI_DATA_DIR（由 shell/Paths.cs 注入），仅兜底自算。
// 与外层 shell/Paths.cs 保持同一优先级链：env > portable.flag(安装根) > %LOCALAPPDATA%\LeiZaiData > 代码目录。
// ⚠ 安装版数据根 = %LOCALAPPDATA%\LeiZaiData（不可用 %LOCALAPPDATA%\LeiZai——那是 Velopack {packId} 安装目录，卸载会整目录删除）。
const fs = require('node:fs');
const path = require('node:path');

/** 代码目录（src 的上一级，只读二进制所在）。 */
const CODE_ROOT = path.resolve(__dirname, '..');
const FLAG = 'portable.flag';

/** 从 startDir 起（含自身）上溯最多 2 层找 portable.flag；返回其目录或 null。 */
function findPortableFlag(startDir) {
  let d = path.resolve(startDir);
  for (let i = 0; i < 3; i++) {
    try { if (fs.existsSync(path.join(d, FLAG))) return d; } catch { /* ignore */ }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

let _root = null;

/** 可变数据根。 */
function root() {
  if (_root) return _root;
  // ① env 优先（C# 注入 / 测试隔离 / 运维覆盖）
  if (process.env.LEIZAI_DATA_DIR) { _root = path.resolve(process.env.LEIZAI_DATA_DIR); return _root; }
  // ② portable.flag（安装根 / 绿色目录）
  const f = findPortableFlag(CODE_ROOT);
  if (f) { _root = f; return _root; }
  // ③ %LOCALAPPDATA%\LeiZaiData（安装版默认；避开 Velopack {packId} 安装目录 %LOCALAPPDATA%\LeiZai，防卸载误删）
  const lad = process.env.LOCALAPPDATA || process.env.USERPROFILE;
  if (lad) { _root = path.join(lad, 'LeiZaiData'); return _root; }
  // ④ 兜底
  _root = CODE_ROOT;
  return _root;
}

module.exports = {
  CODE_ROOT,
  root,
  configPath: () => path.join(root(), 'config.json'),
  commonPath: () => path.join(root(), 'config.common.json'),
  dataDir: () => path.join(root(), 'data'),
  logsDir: () => path.join(root(), 'logs'),
  webViewDataDir: () => path.join(root(), 'webview2-data'),
};
