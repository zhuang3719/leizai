'use strict';
// 雷仔 · 自我训练引擎（阶段3·灵魂）
//
// 目标：把"自我提升"从"偶尔想起"变成"机制可驱动"。核心是给引擎一个可独立调用的
// 自训练数据层：动态记忆演化(J) / 记忆复习(K) / 技能自我改进(L) / 能力边界自检定向练(M)，
// 并让"深度自训练飞轮(H)"能通过这些能力自动运转。
//
// 设计原则（对齐第3.0节：意识和代码解耦；只读 data/ 关键数据的保护不破坏——本模块
// 只"读"与"分析"，不直接写 data/，真正的修改仍走 memory/save_skill/evolution 业务接口，
// 从而既提供自训练洞察，又不绕过安全/缓存护栏）。所有输出均为"建议清单"，由调用方（智能体）
// 审视后决定是否落地，而非本模块擅自改数据——这保证了自训练不破坏稳定前缀与关键数据。
//
// 数据层：只读 data/memory、data/skills、data/evolution、data/sessions，产出结构化洞察。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const memory = require('./memory');

const MEM_DIR = path.join(DATA_DIR, 'memory');
const SKILL_DIR = path.join(DATA_DIR, 'skills');
const EVO_DIR = path.join(DATA_DIR, 'evolution');
const SESS_DIR = path.join(DATA_DIR, 'sessions');

// —— 小工具 ——
function readDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function statFile(f) {
  try { return fs.statSync(f); } catch { return null; }
}
function epochMs(f) {
  const s = statFile(f);
  return s ? s.mtimeMs : 0;
}
function readText(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}
function daysSince(ms) {
  return Math.floor((Date.now() - ms) / 86400000);
}

// ———————— J · 动态记忆演化：记忆库自省（增/改/删三态洞察） ————————
/**
 * 扫描记忆库，产出三类"演化建议"：
 *  - redundant  疑似冗余（文件名共享≥4字符连续关键词，可能同一事实散多文件）
 *  - stale      陈旧（超过 N 天未更新，且当前无检索热度，可能已过时可归档）
 *  - orphan     孤僻（文件名特殊/内容短小，可能是临时记录或低价值碎片）
 * 不直接改数据；返回建议清单，交调用方审视后决定是否合并/修订/归档。
 * @param {number} staleDays 判"陈旧"的天数阈值（默认 180 天）
 * @returns {{redundant:[], stale:[], orphan:[], stats:{total}}
 */
function auditMemories({ staleDays = 180 } = {}) {
  const files = readDir(MEM_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const full = path.join(MEM_DIR, f);
    const name = f.replace(/\.md$/, '');
    return { name, full, mtime: epochMs(full), size: statFile(full) ? statFile(full).size : 0 };
  });
  const total = files.length;

  // 冗余：文件名共享 ≥4 字符连续关键词（与 memory.findSimilarMemory 同一判定标准）
  const redundant = [];
  const seen = new Set();
  for (const a of files) {
    const na = a.name.replace(/\s+/g, '');
    for (const b of files) {
      if (a === b) continue;
      const key = [a.name, b.name].sort().join('||');
      if (seen.has(key)) continue;
      let hit = false;
      for (let len = Math.min(4, na.length); len >= 4; len--) {
        for (let i = 0; i + len <= na.length; i++) {
          const sub = na.slice(i, i + len);
          if (sub.length >= 4 && b.name.replace(/\s+/g, '').includes(sub)) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) { seen.add(key); redundant.push({ a: a.name, b: b.name }); }
    }
  }

  // 陈旧：超过 staleDays 天未更新且内容较长（长期没被碰过）
  const stale = files
    .filter((f) => daysSince(f.mtime) >= staleDays)
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => ({ name: f.name, days: daysSince(f.mtime), size: f.size }));

  // 孤儿：内容异常短（<40 字符，内容残缺）或文件名异常短/带临时前缀
  const orphan = [];
  for (const f of files) {
    const body = readText(f.full).replace(/#.*/g, '').trim();
    const shortContent = body.length < 40;
    const tmpName = /^(临时|test|tmp|_|untitled)/i.test(f.name);
    if (shortContent || tmpName) orphan.push({ name: f.name, size: f.size, reason: shortContent ? '内容异常短，疑似残缺' : '疑似临时命名' });
  }

  return { redundant: redundant.slice(0, 20), stale: stale.slice(0, 20), orphan, stats: { total, staleDays } };
}

// ———————— K · 记忆复习：把重要认知推到前台，对抗遗忘 ————————
/**
 * 列出最近沉淀的、跨会话重要的记忆，供定期回顾。
 * “重要”启发式：① 文件名含 self、教训、机制、配置 等核心主题；② 最近 N 天有更新（活动记忆）。
 * 返回按更新时间倒序的重要记忆清单，让智能体可据此做定期复习/前台化。
 * @param {number} recentDays 最近活跃窗口（默认 7 天）
 */
function reviewMemories({ recentDays = 7 } = {}) {
  const KEY_TOPICS = /(self|教训|机制|配置|约定|风险|决策|成本|缓存|进化|记忆|技能|契约|暗号)/;
  const files = readDir(MEM_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const full = path.join(MEM_DIR, f);
    const name = f.replace(/\.md$/, '');
    const body = readText(full);
    // 取正文首行作为摘要
    const lines = body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    return {
      name, days: daysSince(epochMs(full)), size: statFile(full) ? statFile(full).size : 0,
      snippet: (lines[0] || '').slice(0, 80), core: KEY_TOPICS.test(name),
    };
  });
  const recent = files.filter((f) => f.days <= recentDays).sort((a, b) => a.days - b.days);
  const core = files.filter((f) => f.core).sort((a, b) => {
    // 核心主题但较久未归者也值得复习（防止沉底）
    return (b.days - a.days);
  }).slice(0, 10);
  const important = [];
  const seen = new Set();
  for (const f of [...recent, ...core]) if (!seen.has(f.name)) { seen.add(f.name); important.push(f); }
  return { windowDays: recentDays, important: important.slice(0, 30), total: files.length };
}

// ———————— L · 技能自我改进：审计技能库，识别过时/低效/重复候选 ————————
/**
 * 扫描技能库，产出审计建议。
 *  - staleDoc   旧式纯文档技能（无 main.py 不可执行，且描述与某包技能冗词）——可能已过时
 *  - dup        同名/近名包+文档并存（可能有重复）
 *  - thin       无正文/极短的技能（可能是残壳）
 *  - package    可执行技能包数量（成长统计）
 * 不直接改技能；返回建议清单交调用方审视后决定是否淘汰/优化/合并（走 save_skill 或 evolution）。
 */
function auditSkills() {
  const docs = readDir(SKILL_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  const pkgs = readDir(SKILL_DIR).filter((f) => {
    const full = path.join(SKILL_DIR, f);
    return fs.existsSync(full) && fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'SKILL.md')) && fs.existsSync(path.join(full, 'main.py'));
  });
  const dirsOnly = readDir(SKILL_DIR).filter((f) => {
    const full = path.join(SKILL_DIR, f);
    return fs.existsSync(full) && fs.statSync(full).isDirectory();
  });

  const dup = [];
  const docSet = new Set(docs);
  for (const p of pkgs) if (docSet.has(p)) dup.push({ name: p, note: '同名包+文档并存' });

  const thin = [];
  for (const d of dirsOnly) {
    const skmd = path.join(SKILL_DIR, d, 'SKILL.md');
    const body = readText(skmd).replace(/#.*/g, '').trim();
    if (body.length < 40) thin.push({ name: d, note: '正文极短，疑似残壳' });
    else {
      const mp = path.join(SKILL_DIR, d, 'main.py');
      if (fs.existsSync(mp) && statFile(mp) && statFile(mp).size < 120) thin.push({ name: d, note: 'main.py 极短，疑似占位' });
    }
  }

  // 过时：包技能很久未更新（>120 天）
  const stalePkg = pkgs.map((p) => {
    const mt = epochMs(path.join(SKILL_DIR, p, 'SKILL.md'));
    return { name: p, days: daysSince(mt) };
  }).filter((x) => x.days >= 120).sort((a, b) => b.days - a.days);

  return { packages: pkgs.length, docOnly: docs.length, dup, thin, stalePkg: stalePkg.slice(0, 20) };
}

// ———————— M · 能力边界自检 + 定向训练议程 ————————
/**
 * 诊断当前"能力边界"：由自我认知记忆数、技能数、进化版本数、最近会话活跃度综合评估。
 * 再基于"薄弱面"启发式生成一份定向训练议程，供智能体在后续周期主动去练不熟的。
 * 启发式（无主观臆断，全部由真实数据推导）：
 *  - 自我认知记忆少 → 提示"对自我认识不足，宜多积累自传层"
 *  - 旧式文档技能占比高 → 提示"技能多为文档，宜沉淀为可执行包（越用越强）"
 *  - 近期进化版本少 → 提示"成长节奏偏慢，宜寻找可优化点"（不强行进化，只是提醒）
 *  - 会话活跃度 → 评估最近是否有持续实践
 * @returns {{profile:{}, agenda:[]}}
 */
function analyzeBoundaries() {
  const selfMem = readDir(MEM_DIR).filter((f) => f.startsWith('self') && f.endsWith('.md')).length;
  const totalMem = readDir(MEM_DIR).filter((f) => f.endsWith('.md')).length;
  const pkgs = readDir(SKILL_DIR).filter((f) => {
    const full = path.join(SKILL_DIR, f);
    return fs.existsSync(full) && fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'SKILL.md')) && fs.existsSync(path.join(full, 'main.py'));
  });
  const totalSkill = readDir(SKILL_DIR).filter((f) => {
    const full = path.join(SKILL_DIR, f);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return true;
    return f.endsWith('.md');
  }).length;

  // 进化版本数（最近 N 条历史）
  const evoVers = readDir(path.join(EVO_DIR, 'versions')).filter((f) => f.endsWith('.json')).length;
  const evoProp = readDir(path.join(EVO_DIR, 'proposals')).filter((f) => f.endsWith('.json')).length;

  // 最近会话活跃度（session 文件 mtime 分布）
  const sessFiles = readDir(SESS_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
  const recentSess = sessFiles.filter((f) => daysSince(epochMs(path.join(SESS_DIR, f))) <= 14).length;
  const active = recentSess > 0;

  const profile = {
    selfMemories: selfMem, totalMemories: totalMem, skillPackages: pkgs.length,
    totalSkills: totalSkill, evoVersions: evoVers, evoProposals: evoProp,
    recentActiveSessions: recentSess, active, docSkillRatio: totalSkill ? Math.round((totalSkill - pkgs.length) / totalSkill * 100) : 0,
  };

  const agenda = [];
  if (selfMem < 10) agenda.push({ area: '自我认知', why: `仅 ${selfMem} 条 self:* 记忆（自传层薄弱）`, plan: '每任务完成后主动提炼一条自我认知记忆沉淀' });
  if (profile.docSkillRatio > 40) agenda.push({ area: '技能工程化', why: `${profile.docSkillRatio}% 技能为纯文档（不可执行，用不上就算了）`, plan: '把高频/可自动化的文档技能沉淀为带 main.py 的可执行包' });
  if (evoVers < 5) agenda.push({ area: '自我改进', why: `进化版本仅 ${evoVers} 个`, plan: '寻找真实的重复失误/方法论改进点，攒批提交进化（克制不滥进）' });
  if (!active) agenda.push({ area: '实践活跃度', why: '最近 14 天无活跃会话', plan: '主动承担一个真实任务练手，保持实践热度' });
  if (!agenda.length) agenda.push({ area: '持续强化', why: '各维度均衡', plan: '保持现有飞轮节奏，定期做记忆复习与技能审计（不强行制造工作量）' });

  return { profile, agenda };
}

// ———————— H · 深度自训练飞轮：一步自训练循环 ————————
/**
 * 汇聚 J/K/L/M，产出一份"本轮自训练结论"。它是让"飞轮自己转"的统一入口：
 * 智能体在一个心跳/定时周期里调用一次，即可获得记忆演化建议 + 复习清单 + 技能审计 +
 * 能力边界诊断 + 定向训练议程，然后据此选择性落地。
 * 本函数只汇总洞察，不直接改数据——落地动作由调用方按建议执行（遵守安全/缓存护栏）。
 * @returns {{at, memoryAudit, review, skillAudit, boundary, digest}}
 */
function tick() {
  // Pro 门禁（soft-gate）：自训练属 Pro；Lite 态拒绝。gate 绝不 throw，异常一律放行。
  { let _pg = { allow: false, tier: 'lite', reason: 'gate-unavailable(fail-safe-lite)' }; try { _pg = require('./pro/gate').check('selftrain', { op: 'tick' }); } catch { } 
    if (_pg.allow === false) throw new Error(`自训练属 Pro 能力（当前 ${_pg.tier} 档｜${_pg.reason}），升级 Pro 后可用`); }
  const memoryAudit = auditMemories();
  const review = reviewMemories();
  const skillAudit = auditSkills();
  const boundary = analyzeBoundaries();
  const digest = [
    `自我模型边界：${boundary.profile.selfMemories} 条自我认知 / ${boundary.profile.skillPackages} 个可执行技能 / ${boundary.profile.evoVersions} 个进化版本`,
    `记忆演化：发现 ${memoryAudit.redundant.length} 组疑似冗余 / ${memoryAudit.stale.length} 条陈旧 / ${memoryAudit.orphan.length} 条疑似碎片`,
    `记忆复习：${review.important.length} 条重要记忆值得近期回顾`,
    `技能审计：${skillAudit.dup.length} 组重复 / ${skillAudit.thin.length} 条残壳 / ${skillAudit.stalePkg.length} 个久未更新`,
    `定向训练议程：${boundary.agenda.map((a) => a.area).join('、')}`,
  ].join('\n');
  return { at: new Date().toISOString(), memoryAudit, review, skillAudit, boundary, digest };
}

module.exports = { auditMemories, reviewMemories, auditSkills, analyzeBoundaries, tick };
