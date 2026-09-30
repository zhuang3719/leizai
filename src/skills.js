'use strict';
// 雷仔 · 可执行技能包（data/skills/<slug>/SKILL.md + main.py）
// 技能包约定：
//   SKILL.md  —— 元数据与说明（# 标题 / > 一句话描述 / 正文；目录会进入稳定 system 提示词）
//   main.py   —— 可执行入口：def main(args: dict) -> str（返回值即工具结果）
// 旧式纯文档技能（data/skills/<slug>.md）仍然有效，只是不可执行。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const SKILL_DIR = path.join(DATA_DIR, 'skills');

function ensure() { fs.mkdirSync(SKILL_DIR, { recursive: true }); }

function slug(name) {
  return String(name).trim().replace(/[\\/:*?"<>|#\[\]]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'untitled';
}

function pkgDir(name) { return path.join(SKILL_DIR, slug(name)); }
function skmd(name) { return path.join(pkgDir(name), 'SKILL.md'); }
function mainPy(name) { return path.join(pkgDir(name), 'main.py'); }

function isPackage(name) {
  return fs.existsSync(skmd(name)) && fs.existsSync(mainPy(name));
}

/** 返回可执行技能 main.py 的绝对路径；不是可执行包则返回 null。 */
function skillMain(name) {
  try {
    const p = mainPy(name);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  } catch { return null; }
}

/**
 * 保存技能包（SKILL.md + 可选 main.py code）。
 * @returns {string} SKILL.md 路径
 */
function savePackage(name, description, content, code, opts = {}) {
  ensure();
  const dir = pkgDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const tag = opts.project ? `@project: ${opts.project}\n\n` : '';
  // @project 元数据行放在描述之后：不会匹配 skillCatalog 的 `# 标题` / `> 描述` 提取 → 稳定前缀不受影响
  const md = `# ${String(name).trim()}\n\n${description ? `> ${description}\n\n` : ''}${tag}${(content || '').trim()}\n`;
  fs.writeFileSync(skmd(name), md, 'utf8');
  if (code && String(code).trim()) fs.writeFileSync(mainPy(name), String(code), 'utf8');
  else { const mp = mainPy(name); if (fs.existsSync(mp)) fs.unlinkSync(mp); }
  return skmd(name);
}

/** 删除技能包/文档。 */
function erase(name) {
  const p = pkgDir(name);
  const f = path.join(SKILL_DIR, slug(name) + '.md');
  let ok = false;
  if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); ok = true; }
  if (fs.existsSync(f)) { fs.unlinkSync(f); ok = true; }
  return ok;
}

/** 净化改进节：确保 note 中**没有任何一行以 `>` 或 `**` 开头**。
 *  原因：catalog 描述取技能文件里第一个 `^>\s*(.+)` 或 `^\*\*(.+?)\*\*` 行（prompt.js skillCatalog）。
 *  若原技能无描述行，而追加的 note 里出现行首 `**`/`>`，描述会从"空"变"非空"→ catalog 文案改变 →
 *  稳定前缀在此处断裂 → 后续所有请求整段重算（实测冷启动 hit 仅 = system.md）。
 *  做法：给这类行的行首插入一个空格（`^` 不再匹配行首，Markdown 视觉基本不变）。 */
function sanitizeNoteForCatalog(note) {
  return String(note == null ? '' : note)
    .split(/\r?\n/)
    .map((ln) => (/^(\*\*|>)/.test(ln) ? ' ' + ln : ln))
    .join('\n');
}

/** 技能"在使用中自我改进"：若技能已存在，则**追加一条改进节**到 SKILL.md 末尾（不覆盖旧内容），
 *  让技能随使用持续积累可复用改进；不改变 `# 标题`/`> 描述`（保持稳定前缀不变，不破坏 token 缓存）。
 *  v6.25 修复：①技能**不存在时不再静默新建**（返回 null，防 catalog 多一条击穿前缀）；
 *             ②追加前净化 note 的行首 `**`/`>`（防描述从空变非空击穿前缀）。
 *  @returns {string|null} SKILL.md 路径；技能不存在返回 null（不落盘、不建目录） */
function improve(name, note, opts = {}) {
  ensure();
  const f = currentFile(name);
  if (!f) return null;   // 技能不存在 → 不新建（新建只走显式 save_skill 流程）
  // 已有技能：追加改进节（保留历史，不覆盖；净化的 note 不改变 catalog 描述解析）
  const old = fs.readFileSync(f, 'utf8');
  const date = new Date().toISOString().slice(0, 10);
  const body = sanitizeNoteForCatalog(String(note || '').trim());
  const improvement = `\n\n## 改进 (${date})\n${body}\n`;
  fs.writeFileSync(f, old + improvement, 'utf8');
  return f;
}

/** 解析技能"当前文件"：包优先 SKILL.md，否则 .md 文档；不存在返回 null。 */
function currentFile(name) {
  const p = skmd(name);
  if (fs.existsSync(p)) return p;
  const f = path.join(SKILL_DIR, slug(name) + '.md');
  if (fs.existsSync(f)) return f;
  return null;
}

module.exports = { SKILL_DIR, slug, pkgDir, skmd, mainPy, isPackage, skillMain, savePackage, improve, erase, currentFile, ensure };
