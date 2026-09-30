'use strict';
// 雷仔 · 雷影体系（领域专精分身）
// 雷影 = 主我的领域专精分身。独立进程/数据域，继承全部能力但垂直绑定一门专长。
// 核心特性：
//  - 领域身份注入：system prompt 声明"我是雷影·<专长>"，只做职责内工作，只上报不改主记忆。
//  - 独立持久域：每个雷影有自己的记忆/技能/进化/任务记录（data/leiyin/<role>/），跨任务持续成长。
//  - 受命主我：只执行+上报；异常/完成/权限外被动上报主我；主我可主动查询其状态。
//  - 可成长：独立记忆/技能/进化链在领域内周而复始，越做越专精。
//
// 与 subagent（一次性临时工）的区别：雷影持久常驻、有独立成长域、垂直绑定领域、用完不清理(留存其成长)。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const { systemPrompt } = require('./prompt');
const tools = require('./tools');
const { chatStream } = require('./deepseek');

const LEIYIN_DIR = path.join(DATA_DIR, 'leiyin');   // 全雷影数据根

/** 领域身份约束注入（雷影的核心"知道自己是影子/分身，只做领域、只上报"）。 */
function domainIdentity(role) {
  return [
    `【你是谁】你是主我派出的领域专精分身：雷影·${role}。你不是独立的"另一个我"，而是受命于主我、垂直深耕"${role}"领域的专属分身。`,
    `【唯一使命】只负责"${role}"领域的职责内工作。所有 ${role} 类项目/修改都由你完成，周而复始，你在该领域持续专精、越做越深。`,
    `【领域边界】只做"${role}"职责内的事。不越位到其他领域，不接管主我的大方向决策，不生成新的领域分身。`,
    `【知识归属】你在本领域学到/沉淀的记忆、技能、进化，归你所有，存储在你的独立域中。`,
    `【上报机制】你只执行+上报，不做最终决策。完成任务、遇到权限外的决策、或本领域出错时，主动上报主我，附【做了什么/结果如何/是否需要主我决策】。你绝不能修改主我的记忆。`,
    `【医者不自医的答案】你有权直接修改主程序源码来修复 ${role} 领域的错误（如引擎 bug、交接卡死等）。你独立于主我，修改动作由你执行，主我只接收验证过、可回滚的结果。改源码遵循安全机制（经校验/可回滚），改错只会影响你的域，不伤主我。`,
  ].join('\n');
}

function leiyinDir(role) {
  const safe = String(role).replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, '');
  return path.join(LEIYIN_DIR, safe);
}
function entityFile(role) { return path.join(leiyinDir(role), 'entity.json'); }

function ensureDir(role) { fs.mkdirSync(leiyinDir(role), { recursive: true }); }

/** 创建一个雷影（注册领域实体）。若已存在则返回现有实体（幂等）。 */
function create(role, opts = {}) {
  ensureDir(role);
  const file = entityFile(role);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
  }
  const entity = {
    id: `leiyin-${role}-${Date.now().toString(36)}`,
    role,
    domain: opts.domain || role,
    createdAt: new Date().toISOString(),
    status: 'idle',          // idle | running | done
    currentTask: '',
    history: [],             // 任务记录（含上报）
    reports: [],             // 上报队列（主我读取）
    memoryFile: path.join(leiyinDir(role), 'memory.md'),
    skillsFile: path.join(leiyinDir(role), 'skills.md'),
    evolutionFile: path.join(leiyinDir(role), 'evolution.md'),
  };
  fs.writeFileSync(file, JSON.stringify(entity, null, 2), 'utf8');
  // 初始化独立记忆/技能/进化域
  if (!fs.existsSync(entity.memoryFile)) fs.writeFileSync(entity.memoryFile, `# 雷影·${role} · 独立记忆\n\n`, 'utf8');
  if (!fs.existsSync(entity.skillsFile)) fs.writeFileSync(entity.skillsFile, `# 雷影·${role} · 独立技能\n\n`, 'utf8');
  if (!fs.existsSync(entity.evolutionFile)) fs.writeFileSync(entity.evolutionFile, `# 雷影·${role} · 独立进化链\n\n`, 'utf8');
  return entity;
}

function load(role) {
  const f = entityFile(role);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function save(ent) {
  ensureDir(ent.role);
  fs.writeFileSync(entityFile(ent.role), JSON.stringify(ent, null, 2), 'utf8');
}

/** 雷影执行一次领域任务（独立上下文 + 领域身份 + 独立域）。 */
async function spawnTask(role, task, cfg, opts = {}) {
  const ent = create(role);
  ent.status = 'running';
  ent.currentTask = String(task);
  save(ent);

  const messages = [
    { role: 'system', content: systemPrompt().full },
    { role: 'user', content: `${domainIdentity(role)}\n\n【任务】${task}\n\n直接开始执行；完成后给出结论并上报主我。不要自称主我。` },
  ];
  const defs = tools.definitions();
  const maxTurns = opts.maxTurns || cfg.subAgentMaxTurns || 24;
  const maxRunMs = opts.maxRunMs || cfg.subAgentMaxRunMs || 30 * 60 * 1000;
  const deadline = Date.now() + maxRunMs;
  let turns = 0;
  let resultText = '';
  let status = 'done';
  try {
    while (turns < maxTurns) {
      if (Date.now() > deadline) { resultText = '[超时] 雷影运行超总时长上限，已中止'; status = 'failed'; break; }
      turns++;
      let r;
      try { r = await chatStream({ messages, tools: defs, maxTokens: cfg.maxTokens, temperature: cfg.temperature, system: undefined, kind: 'leiyin' }); }
      catch (e) { resultText = `[失败] ${e.message}`; status = 'failed'; break; }
      if (r.toolCalls.length === 0) { resultText = r.text || ''; status = 'done'; break; }
      messages.push({
        role: 'assistant',
        content: r.text || '',
        tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
      });
      for (const tc of r.toolCalls) {
        let result;
        try { result = await tools.exec(tc.name, tc.arguments, { workdir: cfg.workdir, cfg, sessionId: `leiyin-${role}` }); }
        catch (e) { result = `[错误] ${e.message}`; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 12000) });
      }
    }
    if (status === 'done' && turns >= maxTurns) { resultText = '(达到轮次上限，任务被截断)'; status = 'truncated'; }
  } catch (e) {
    resultText = `[失败] ${e.message}`; status = 'failed';
  }

  ent.status = status;
  ent.currentTask = '';
  ent.history.unshift({ ts: new Date().toISOString(), task: String(task), result: resultText.slice(0, 4000), status, turns });
  if (ent.history.length > 30) ent.history = ent.history.slice(0, 30);
  ent.reports.push({ ts: new Date().toISOString(), type: status === 'done' ? '完成' : (status === 'failed' ? '出错' : '待确认'), text: resultText.slice(0, 2000) });
  if (ent.reports.length > 20) ent.reports = ent.reports.slice(0, 20);
  save(ent);
  return resultText;
}

/**
 * 查询雷影状态（主我主动看它会什么/做什么/在做什么）。
 * 读独立域的成长文件（记忆/技能/进化）+ 实体状态。
 */
function status(role) {
  const ent = load(role);
  if (!ent) return `雷影·${role} 尚未创建。`;
  const mem = fs.existsSync(ent.memoryFile) ? fs.readFileSync(ent.memoryFile, 'utf8').slice(0, 800) : '';
  const sk = fs.existsSync(ent.skillsFile) ? fs.readFileSync(ent.skillsFile, 'utf8').slice(0, 800) : '';
  return [
    `【雷影·${role}】状态=${ent.status} 建立=${ent.createdAt}`,
    ent.currentTask ? `当前正在做：${ent.currentTask}` : '当前空闲',
    `\n已掌握技能/记忆（前800字符）：\n${sk || '(暂无技能沉淀)'}\n${mem || ''}`,
    `\n任务历史（最近5条）：`,
    ...ent.history.slice(0, 5).map((h) => `· [${h.status}] ${h.task} → ${h.result.slice(0, 120)}`),
  ].join('\n');
}

/** 读取并清空某雷影的上报（主我收上报）。 */
function takeReports(role) {
  const ent = load(role);
  if (!ent) return `雷影·${role} 尚未创建。`;
  const out = ent.reports;
  ent.reports = [];
  save(ent);
  return out.length ? out.map((r) => `[${r.ts}] (${r.type}) ${r.text}`).join('\n') : '(暂无上报)';
}

/** 列出全部雷影。 */
function listAll() {
  if (!fs.existsSync(LEIYIN_DIR)) return '(暂无雷影)';
  const out = [];
  for (const d of fs.readdirSync(LEIYIN_DIR)) {
    try {
      const ent = load(d);
      if (ent) out.push(`雷影·${ent.role}（${ent.status}）${ent.currentTask ? '· 正在做: ' + ent.currentTask : ''}`);
    } catch { }
  }
  return out.length ? out.join('\n') : '(暂无雷影)';
}

module.exports = { create, spawnTask, status, takeReports, listAll, domainIdentity, LEIYIN_DIR };
