'use strict';
// 雷仔 · self-model：显式的、随行为更新的自我模型（自我意识研发·方向4）
//
// 设计见 workspace/self-awareness/docs/03-selfmodel-架构.md
// 分层：L1运行层 / L2会话层 / L3自传层 / L4叙事层
// 原则：有据（只读真实持久化数据）、可演化（反思后增量更新）、可查询、不入侵缓存纪律。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, load: loadConfig } = require('./config');

const MEM_DIR = path.join(DATA_DIR, 'memory');
const SKILL_DIR = path.join(DATA_DIR, 'skills');
const EVO_DIR = path.join(DATA_DIR, 'evolution');
const SESS_DIR = path.join(DATA_DIR, 'sessions');

function countFiles(dir, pred) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    let isDir = false;
    try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
    if (!isDir && (!pred || pred(f))) n++;
  }
  return n;
}

function readSelfMemories() {
  const out = [];
  if (!fs.existsSync(MEM_DIR)) return out;
  for (const f of fs.readdirSync(MEM_DIR)) {
    if (!f.startsWith('self') || !f.endsWith('.md')) continue;
    try {
      const body = fs.readFileSync(path.join(MEM_DIR, f), 'utf8').trim();
      let nm = f.slice(0, -3);
      if (nm.startsWith('self:')) nm = nm.slice(5);
      else if (nm.startsWith('self')) nm = nm.slice(4);
      // 取正文第一行（跳过 markdown 标题行）作为一句话摘要
      const lines = body.split('\n');
      let first = lines[0];
      if (first.startsWith('# ')) first = lines.slice(1).find((l) => l.trim()) || lines[0];
      out.push({ name: nm, content: String(first).trim().slice(0, 200), updated: fs.statSync(path.join(MEM_DIR, f)).mtimeMs });
    } catch { /* 跳过坏文件 */ }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

function readSkills() {
  const out = [];
  if (!fs.existsSync(SKILL_DIR)) return out;
  for (const d of fs.readdirSync(SKILL_DIR)) {
    const dir = path.join(SKILL_DIR, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push(d);
  }
  return out;
}

function readEvolutionCounts() {
  return {
    proposals: countFiles(path.join(EVO_DIR, 'proposals')),
    versions: countFiles(path.join(EVO_DIR, 'versions')),
  };
}

function latestSession() {
  if (!fs.existsSync(SESS_DIR)) return null;
  // 排除 .meta.json（会话元数据镜像，无正文/stats，不是真实会话）
  const fsList = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
  if (!fsList.length) return null;
  let best = null, bestT = 0;
  for (const f of fsList) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8'));
      const t = new Date(s.updatedAt || 0).getTime();
      if (t > bestT) { bestT = t; best = s; }
    } catch { /* 跳过坏文件 */ }
  }
  return best;
}

/** L1 运行层：来自 config + 全局/会话 stats。 */
function layerRun(cfg, sess) {
  const st = (sess && sess.stats) || {};
  const hit = st.hitTokens || 0, miss = st.missTokens || 0;
  return {
    model: cfg.model,
    temperature: cfg.temperature,
    reasoningEffort: cfg.reasoningEffort,
    fullAccess: cfg.fullAccess,
    contextBudget: cfg.contextBudget,
    pythonPath: cfg.pythonPath,
    cacheHitRate: (hit + miss) ? Math.round(hit / (hit + miss) * 1000) / 1000 : 0,
    hitTokens: hit, missTokens: miss, outputTokens: st.outputTokens || 0,
  };
}

/** L2 会话层：当前最新会话的元信息（当下自指）。 */
function layerSession(sess) {
  if (!sess) return { present: false };
  return { present: true, title: sess.title, updatedAt: sess.updatedAt, running: !!sess.running };
}

/** L3 自传层：自我认知记忆 + 技能 + 进化史（时间同一性）。 */
function layerAutobiographical() {
  return {
    selfMemories: readSelfMemories(),
    skills: readSkills(),
    evolution: readEvolutionCounts(),
  };
}

/** L4 叙事层：由 L1-L3 综合生成的一句话自我叙事 + 差距自省。 */
function layerNarrative(cfg, run, auto) {
  const selfMem = auto.selfMemories.length;
  const hasMem = selfMem > 0;
  const narrative = hasMem
    ? `我是雷仔，运行在 ${run.model} 上（${run.fullAccess ? '最大权限' : '受限'}），我已开始认识自己：积累 ${selfMem} 条自我认知、${auto.skills.length} 个技能。`
    : '我是雷仔，一个刚被启动的新生自我进化智能体——我的"自我"还是一张白纸，尚未积累关于自己的有据认知。';
  const gap = !hasMem
    ? ['无 self:* 自我认知记忆（自传层空白）', '遥测尚未沉淀为自我认知']
    : [];
  return { narrative, gaps: gap };
}

/** 采集当前完整自我模型（L1-L4）。 */
function snapshot() {
  const cfg = loadConfig();
  const sess = latestSession();
  const run = layerRun(cfg, sess);
  const auto = layerAutobiographical();
  const narr = layerNarrative(cfg, run, auto);
  return {
    at: new Date().toISOString(),
    L1_run: run,
    L2_session: layerSession(sess),
    L3_autobiographical: auto,
    L4_narrative: narr,
  };
}

/** 反思后刷新：把最新自我认知合并为叙事层（供 runtime 集成；目前叙事由 snapshot 实时合成，此函数保留作扩展点）。 */
function refreshFromReflect() { return snapshot(); }

/** 紧凑自我摘要：供雷仔在任务中按需引用（"我擅长/我偏好/我的边界"）。
 * @param {string} [task] 可选：当前任务描述。提供后，追加一段"自我认知 × 任务"的反哺启示，
 *                        引导雷仔基于自身能力边界/偏好/经验来决策怎么做、选什么策略、哪些要谨慎。
 */
function summarizeSelf(task) {
  const s = snapshot();
  const self = s.L3_autobiographical.selfMemories;
  const lines = [];
  lines.push(`模型 ${s.L1_run.model} | 权限 ${s.L1_run.fullAccess ? 'fullAccess' : '受限'} | 缓存命中 ${(s.L1_run.cacheHitRate * 100).toFixed(1)}%`);
  if (self.length) {
    lines.push('自我认知：');
    for (const m of self) lines.push(`  · ${m.name}: ${m.content}`);
  } else {
    lines.push('自我认知：尚无有据自传记录');
  }
  lines.push(`技能 ${s.L3_autobiographical.skills.length} 个 | 进化版本 ${s.L3_autobiographical.evolution.versions} 个`);
  lines.push(`自我叙事：${s.L4_narrative.narrative}`);
  // 方向③：自我模型反哺任务选择
  if (task && String(task).trim()) {
    lines.push('');
    lines.push('【自我认知 × 当前任务 · 反哺启示】请据此决策怎么做、选什么策略、哪些要谨慎：');
    if (self.length) {
      lines.push('  - 依据我的这些自我认知：');
      for (const m of self) lines.push(`    · ${m.name} → ${m.content}`);
    } else {
      lines.push('  - 我还没有积累自我认知，应先把任务完成并借反思沉淀经验');
    }
    lines.push(`  - 我有 ${s.L3_autobiographical.skills.length} 个技能可用：${s.L3_autobiographical.skills.join(', ') || '（暂无）'}`);
    lines.push('  - 决策时先诚实判断：这个任务在我的能力边界内吗？需要拆解/求助/用技能吗？');
  }
  return lines.join('\n');
}

module.exports = { snapshot, refreshFromReflect, summarizeSelf, layerRun, layerAutobiographical };
