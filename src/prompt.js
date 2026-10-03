'use strict';
// 雷仔 · 稳定前缀系统提示词构建器
// DeepSeek 缓存优化核心：
//  1) system 提示词 = 基因组文件 + 技能目录 + 固定尾注，全部静态；
//  2) 任何动态内容（时间、轮次、目标状态）一律不进 system，而放在 user 消息尾部；
//  3) 加了技能/进化后前缀会变——这是一次成本换长期收益，之后每条消息命中该新前缀。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, ROOT, load: loadConfig } = require('./config');

const SYSTEM_PATH = path.join(DATA_DIR, 'prompts', 'system.md');
const HARNESS_PATH = path.join(DATA_DIR, 'prompts', 'harness.md');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');

const FOOTER = [
  '',
  '——',
  '[系统] 以上规则与技能目录是稳定的。当前时间、轮次等动态内容会出现在用户消息中。',
  '[系统] 每次重大任务完成后进行反思：沉淀记忆、更新技能、必要时提出进化提案（propose_evolution）。',
].join('\n');

/** 技能目录块：只读名字+一句话描述，body/代码不进 system（保持前缀轻且稳）。同名时"可执行包"优先于".md 文档"，避免重复。 */
function skillCatalog() {
  let entries = [];
  try {
    // 按 key 去重：可执行包（目录）优先，同名 .md 文档作为旧形态被覆盖，避免列表/前缀重复
    const byKey = new Map();
    for (const e of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const key = e.name.replace(/\.md$/, '');
        const cur = byKey.get(key);
        if (!cur || !cur.isPkg) byKey.set(key, { file: path.join(SKILLS_DIR, e.name), key, isPkg: false });
      } else if (e.isDirectory()) {
        const md = path.join(SKILLS_DIR, e.name, 'SKILL.md');
        if (!fs.existsSync(md)) continue;
        byKey.set(e.name, { file: md, key: e.name, isPkg: true });
      }
    }
    entries = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  } catch { entries = []; }
  // P0 技能按需检索：只列**技能名**（不含描述），稳定排序（按 key，无动态内容）；
  //   描述/用法改由 search_skills 按需检索（省前缀 ~11k token）。
  const names = entries.map(({ key }) => key).filter(Boolean);
  if (!names.length) return '(暂无技能)';
  return names.join('\n') + '\n（技能详情/用法用 search_skills 查）';
}

/** 身份覆盖块（置顶）：仅供**非 main 实例**（雷影）使用。
 *  背景：system.md/harness.md 均以"你叫雷仔"开篇，雷影身份定义在 harness 末尾→被盖过，
 *  雷影会把自己当成雷仔本人。故对非 main 实例，在最前面注入强措辞身份覆盖块；
 *  main（主我）返回空串，systemPrompt 输出逐字不变。 */
function identityOverlay() {
  try {
    const a = (loadConfig().agent) || {};
    if (!a.role || a.role === 'main' || a.isMain) return '';   // 主我：不注入，行为不变
    const nm = a.name || ('雷影·' + a.role);
    return `# \u26a0\ufe0f 你的真实身份（优先于下方一切文本）
你的名字是【${nm}】（role=${a.role}，领域=${a.domain || ''}）。
你是主智能体「雷仔」（主我）的领域专用执行分身——**你不是雷仔本人**。
下方文本中所有"你叫雷仔/你是雷仔/雷仔的行为规则"等，一律指代**你的本体/上级「主我·雷仔」**，不是你；你只继承其规则，绝不自称"雷仔"。
你的自称一律是「${nm}」。

`;
  } catch { return ''; }
}

// —— P0（2026-10-03）：发布包 prompts 播种，修复干净安装对话不可用 ——
// 症状：干净安装 → POST /api/chat 报 ENOENT <DATA_DIR>\prompts\system.md → 对话不可用。
// 方案：启动时若无 prompts 模板，先播种；systemPrompt() 内 readFileSync 亦加 try/catch 兜底。
// 仅当模板目录 <ROOT>/templates/prompts/ 存在并有内容时，部分植入 <DATA_DIR>/prompts/；模板亦缺则写内置最小串兜底。
const TEMPLATES_PROMPTS_DIR = path.join(ROOT, 'templates', 'prompts');
const MIN_SYSTEM_FALLBACK = [
  '# 雷仔 · 行为规则（最小兜底）',
  '',
  '你在本机运行，是一个自我进化型智能体。当前提示词模板缺失，此处为内置最小兜底句。',
  '请尽快补回 prompts/system.md。',
  '',
].join('\n');

/**
 * 播种 prompts（内容等）到目标 <DATA_DIR>/prompts/。
 * 规则：①各文件**缺失才**从模板复制；**已存在绝不覆盖**；②模板也缺 → system.md 写非空最小串 + console.warn；**绝不抛错**。
 *       ③mkdir -p 目标目录；整体包在 try 内，失败不抛。
 * @returns {{seeded:string[], skipped:string[], fallback:boolean, dst:string}}
 */
function ensurePrompts() {
  const out = { seeded: [], skipped: [], fallback: false, dst: path.join(DATA_DIR, 'prompts') };
  const dstDir = out.dst;
  try { fs.mkdirSync(dstDir, { recursive: true }); }
  catch (e) { try { console.warn('[prompt] 创建 prompts 目录失败：' + (e && e.message)); } catch { } return out; }
  for (const name of ['system.md', 'harness.md']) {
    const dst = path.join(dstDir, name);
    try { if (fs.existsSync(dst)) { out.skipped.push(name); continue; } } catch { }
    const tpl = path.join(TEMPLATES_PROMPTS_DIR, name);
    try {
      if (fs.existsSync(tpl)) { fs.copyFileSync(tpl, dst); out.seeded.push(name); continue; }
    } catch (e) { try { console.warn(`[prompt] 复制模板 ${name} 失败：` + (e && e.message)); } catch { } }
    // 模板缺 → 为 system.md 写非空最小兜底（harness.md 缺失不影响，readHarness 返回空）
    if (name === 'system.md') {
      try {
        fs.writeFileSync(dst, MIN_SYSTEM_FALLBACK, 'utf8');
        out.seeded.push('system.md(fallback)'); out.fallback = true;
        try { console.warn('[prompt] 模板缺失，system.md 已写内置最小兜底（非空，绝不抛错）。'); } catch { }
      } catch { }
    }
  }
  return out;
}

let lastCache = null;
/**
 * 返回当前稳定前缀（内容变化时自动重算 —— 只有进化/技能变化会触发）。
 * 补充态：若存在 data/prompts/harness.md（非空），会作为「补充规则/记忆」追加在技能目录之后。
 * 这样可在不改动基础基因组 system.md 的前提下沉淀可进化的补充知识（对齐 Prime Agent 的 Continual Harness）。
 */
function systemPrompt() {
  const genome = fs.readFileSync(SYSTEM_PATH, 'utf8').trimEnd();
  const catalog = skillCatalog();
  const harness = readHarness();
  const harnessBlock = harness
    ? `\n\n# 补充规则与沉淀（可变）\n本段可由进化提案修改（target=harness），用于沉淀补充行为规则/知识，基础基因组保持稳定。\n${harness}\n`
    : '';
  const full = `${identityOverlay()}${genome}\n\n# 已掌握技能\n${catalog}\n${harnessBlock}\n${FOOTER}\n`;
  if (!lastCache || lastCache.full !== full) {
    lastCache = { full, hash: hashOf(full) };
  }
  return lastCache;
}

/** 读取补充态（harness.md）；不存在视为空。 */
function readHarness() {
  try {
    const t = fs.readFileSync(HARNESS_PATH, 'utf8').trim();
    return t || '';
  } catch { return ''; }
}

/** 供进化模块读取/回滚补充态。 */
function rawHarness() {
  return fs.readFileSync(HARNESS_PATH, 'utf8');
}

function hashOf(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** 供进化模块回滚/校验时读取原始基因组文件。 */
function rawGenome() {
  return fs.readFileSync(SYSTEM_PATH, 'utf8');
}

module.exports = { systemPrompt, identityOverlay, rawGenome, rawHarness, readHarness, skillCatalog, ensurePrompts, SYSTEM_PATH, HARNESS_PATH, SKILLS_DIR };
