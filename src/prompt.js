'use strict';
// 雷仔 · 稳定前缀系统提示词构建器
// DeepSeek 缓存优化核心：
//  1) system 提示词 = 基因组文件 + 技能目录 + 固定尾注，全部静态；
//  2) 任何动态内容（时间、轮次、目标状态）一律不进 system，而放在 user 消息尾部；
//  3) 加了技能/进化后前缀会变——这是一次成本换长期收益，之后每条消息命中该新前缀。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, load: loadConfig } = require('./config');

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

module.exports = { systemPrompt, identityOverlay, rawGenome, rawHarness, readHarness, skillCatalog, SYSTEM_PATH, HARNESS_PATH, SKILLS_DIR };
