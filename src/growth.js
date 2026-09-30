'use strict';
// 雷仔 · 成长仪表盘数据层（阶段4·I）
//
// 目标：量化"我确实在变强"，让记忆/技能/自我认知/能力边界随时间的增长有据可依。
// 原理：定期把 selfmodel.snapshot() 的关键指标追加到 workspace/成长曲线.md（一条记录一个时间点），
//      形成随时间增长的曲线；growth_dashboard() 汇总最新与历史，给出增长结论。
// 原则：只追加不覆盖（保留完整历史曲线）；只读 data/ 关键数据（不改），写的是 workspace 的增长记录。
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, DATA_DIR, load: loadConfig } = require('./config');
const selfmodel = require('./selfmodel');

const WORKSPACE = path.join(ROOT, 'workspace');
const CURVE_FILE = path.join(WORKSPACE, '成长曲线.md');

// 稳定基线：此时间点之前的记录属旧口径（结构/统计方式不同），趋势结论从该点起算，避免虚高
const BASELINE_AT = '2026-09-13 19:02';

/** 取一份成长快照（关键指标）。 */
function snapshot() {
  const s = selfmodel.snapshot();
  return {
    at: s.at,
    memories: s.L3_autobiographical.selfMemories.length,        // 自我认知记忆（self:*）
    totalMemories: countMemories(),
    skills: s.L3_autobiographical.skills.length,                 // 技能数
    evoVersions: s.L3_autobiographical.evolution.versions,       // 进化版本数
    evoProposals: s.L3_autobiographical.evolution.proposals,     // 进化提案数
    sessions: countSessions(),
    cacheHitRate: s.L1_run.cacheHitRate,
    model: s.L1_run.model,
  };
}

function countMemories() {
  const dir = path.join(DATA_DIR, 'memory');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; }
}
function countSessions() {
  // v6.24 修复（任务·交互4项·口径统一）：旧口径 = data/sessions 下所有 .json（排除 .meta.json），
  //   会把"无消息的空壳/测试会话"也算进去（实测 21），与用户实际看到的会话列表（8）不一致 → 顶栏数字误导。
  //   现改为与 runtime.listSessions() 同口径的"有效会话"（有消息/running/pinned/archived，且排除 .bak/测试）。
  try { return require('./runtime').listSessions().length; } catch { }
  // 回退：静态计数（老口径），仅在 runtime 不可用时使用
  const dir = path.join(DATA_DIR, 'sessions');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')).length; } catch { return 0; }
}

/** 记录一份成长快照（追加到成长曲线文件，不覆盖历史）。返回本次快照。 */
function record() {
  const s = snapshot();
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    if (!fs.existsSync(CURVE_FILE)) {
      fs.writeFileSync(CURVE_FILE, '# 雷仔 · 成长曲线\n\n> 来源：growth_snapshot() 定期记录 selfmodel.snapshot() 关键指标。每个时间点一条，形成增长曲线。\n\n| 时间 | 自我认知 | 总记忆 | 技能 | 进化版本 | 进化提案 | 会话 | 缓存命中% | 模型 |\n|---|---|---|---|---|---|---|---|---|\n', 'utf8');
    }
    const pad = (x) => String(x).padStart(2, '0');
    const d = new Date(s.at);
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const line = `| ${ts} | ${s.memories} | ${s.totalMemories} | ${s.skills} | ${s.evoVersions} | ${s.evoProposals} | ${s.sessions} | ${(s.cacheHitRate * 100).toFixed(1)} | ${s.model} |\n`;
    fs.appendFileSync(CURVE_FILE, line, 'utf8');
  } catch (e) {
    return { error: `记录失败: ${e.message}`, snapshot: s };
  }
  return s;
}

/** 自动积累成长快照：距上次记录超过阈值(默认30分钟)或指标相比上次有实质变化时，追加一条快照。
 *  目的：让"进化轨迹曲线"随时间持续积累数据点，呈现真实上升趋势，而非固定2点平直。 */
let _lastAuto = 0;   // 进程内上次自动记录的时间（避免高频调用重复写文件）
function maybeAutoRecord() {
  try {
    if (!fs.existsSync(CURVE_FILE)) return;
    const raw = fs.readFileSync(CURVE_FILE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.includes('时间 |'));
    if (lines.length === 0) return;
    // 解析最后一条的时间戳（yyyy-MM-dd HH:mm）
    const last = lines[lines.length - 1];
    const c = last.split('|').map((x) => x.trim());
    const tParts = c[1].match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    if (!tParts) return;
    const lastTs = new Date(Number(tParts[1]), Number(tParts[2]) - 1, Number(tParts[3]), Number(tParts[4]), Number(tParts[5])).getTime();
    const now = Date.now();
    // 距上次记录已超阈值 → 自动追加一条（让曲线积累）
    if (now - lastTs >= 30 * 60 * 1000) { record(); return; }
    // 指标相比上次有实质变化（技能/记忆/进化任一变化） → 立即追加
    const s = snapshot();
    const lastSkill = Number(c[4]), lastEvo = Number(c[6]), lastMem = Number(c[3]);
    if (s.skills !== lastSkill || s.evoVersions !== lastEvo || s.totalMemories !== lastMem) { record(); }
  } catch { /* 静默：自动记录失败不致命 */ }
}

/** 成长仪表盘展示：读最新曲线，比对首次/最近两次记录，给出增长结论。 */
function dashboard() {
  maybeAutoRecord();
  let rows = [];
  try {
    if (fs.existsSync(CURVE_FILE)) {
      const lines = fs.readFileSync(CURVE_FILE, 'utf8').split('\n').filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.includes('时间 |'));
      rows = lines.map((l) => {
        const c = l.split('|').map((x) => x.trim());
        return { at: c[1], self: c[2], mem: c[3], skill: c[4], evoV: c[5], evoP: c[6], sess: c[7], hit: c[8], model: c[9] };
      });
    }
  } catch { }
  const latest = snapshot();
  const first = rows[0];
  const last = rows[rows.length - 1];
  // 稳定基线：基准取 rows 里第一条 at >= BASELINE_AT 的记录（at 为 'YYYY-MM-DD HH:MM' 字符串，可直接比较）；
  // 找不到（全部记录都早于基线）→ 回退 rows[0]，并在结论中说明"基线前数据不足"。
  const baselineRow = rows.find((r) => r && typeof r.at === 'string' && r.at >= BASELINE_AT) || null;
  const base = baselineRow || first;
  const onBaseline = !!baselineRow;
  // self 口径修正：self 为**可归并计数**，历史归并会造成负跳变（口径变化≠退化）。
  //   在 基线→最新 之间检测首个 Δ<=-50 的负跳变；若有，则以**该跳变后首条记录**作为 self 的新基准。
  const SELF_DROP = -50;
  let selfBaseRow = base;
  let selfMergeNote = '';
  {
    const startIdx = Math.max(0, rows.indexOf(base));
    for (let i = startIdx + 1; i < rows.length; i++) {
      const prev = Number(rows[i - 1].self || 0), cur = Number(rows[i].self || 0);
      if (cur - prev <= SELF_DROP) {
        selfBaseRow = rows[i];
        const day = String(rows[i].at || '').slice(0, 10);
        selfMergeNote = `（自我认知为可归并计数，${day} 发生归并，已按归并后基准计）`;
        break;
      }
    }
  }
  const conclusion = [];
  if (base && last) {
    const dSelf = Math.max(0, latest.memories - Number(selfBaseRow.self || 0));   // 归并后基准计，恒为非负
    const dSkill = latest.skills - Number(base.skill || 0);
    const dEvo = latest.evoVersions - Number(base.evoV || 0);
    if (onBaseline) {
      conclusion.push(`自稳定基线(${BASELINE_AT})以来：自我认知 +${dSelf}、技能 +${dSkill}、进化版本 +${dEvo}（基线内 ${rows.length - rows.indexOf(baselineRow)} 个时间点；历史共 ${rows.length} 点）${selfMergeNote}`);
    } else {
      conclusion.push(`稳定基线(${BASELINE_AT})之后暂无记录，沿用首次记录基准（可能含旧口径虚高）：自我认知 +${dSelf}、技能 +${dSkill}、进化版本 +${dEvo}（已记录 ${rows.length} 个时间点）${selfMergeNote}`);
    }
    if (dSkill > 0 || dSelf > 0) conclusion.push('成长曲线呈上升趋势（记忆/技能/进化持续积累），"确实在变强"有据可依。');
    else conclusion.push('近段指标基本持平——可结合 self_train 检查是"已到稳态"还是"缺有效实践"，针对性找增长点。');
  } else {
    conclusion.push('尚无历史曲线记录。建议定期调用 growth_snapshot() 开始积累。');
  }
  return { latest, historyCount: rows.length, first, last, baseline: BASELINE_AT, baselineRow, conclusion, rows };
}

/** 项目列表（对话即项目）：扫描工作区 projects/ 下各会话的 _progress.md。
 *  返回 [{id, title, mtime, size}]，让前端项目视图能列出所有项目。 */
function projects() {
  const workdir = loadConfig().workdir || path.join(ROOT, 'workspace');
  const projectsRoot = path.join(workdir, 'projects');
  const out = [];
  try {
    if (!fs.existsSync(projectsRoot)) return out;
    for (const d of fs.readdirSync(projectsRoot)) {
      const pf = path.join(projectsRoot, d, '_progress.md');
      if (!fs.existsSync(pf)) continue;
      const raw = fs.readFileSync(pf, 'utf8');
      const title = (raw.match(/^#\s*(.+)$/m) || [])[1] || d;
      out.push({ id: d, title: title.trim(), mtime: fs.statSync(pf).mtimeMs, size: raw.length });
    }
  } catch { }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 项目详情：读某项目（会话）的 _progress.md 全文。
 *  @returns {string|null} 进度正文；项目不存在返回 null。 */
function projectDetail(id) {
  try {
    const workdir = loadConfig().workdir || path.join(ROOT, 'workspace');
    const pf = path.join(workdir, 'projects', String(id).replace(/[^A-Za-z0-9_-]/g, '_'), '_progress.md');
    return fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : null;
  } catch { return null; }
}

module.exports = { snapshot, record, dashboard, projects, projectDetail, CURVE_FILE, BASELINE_AT };
