'use strict';
// 雷仔 · 子智能体（agent protocol 的本地方案）
// 子智能体 = 独立上下文 + 全工具权限（读写文件/跑命令/进化/再派子智能体）+ 独立持久化文件
// 支持 sync（等结果）与 background（拿 id 稍后取结果，结果落盘可跨服务器重启取回）。
// agent 间直接通信：每个智能体有独立消息信箱 data/agents/inbox/<id>.jsonl；
// send() 投递、inbox() 读取并清空；子智能体每轮开始自动收取信箱消息。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const { systemPrompt } = require('./prompt');
const tools = require('./tools');
const { chatStream } = require('./deepseek');

const AGENT_DIR = path.join(DATA_DIR, 'agents');
const INBOX_DIR = path.join(AGENT_DIR, 'inbox');

function ensure() {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}
function ag(id) { return path.join(AGENT_DIR, `${id}.json`); }
function inboxFile(id) { return path.join(INBOX_DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`); }

async function spawn(args, parentCtx) {
  ensure();
  pruneOld(); // 新派子智能体前清理过期旧记录，防无限膨胀
  const cfg = parentCtx.cfg;
  const id = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const record = {
    id, ts: new Date().toISOString(), role: args.role || '子智能体', task: args.task,
    status: 'running', result: '', usage: null, parentSession: parentCtx.sessionId,
  };
  fs.writeFileSync(ag(id), JSON.stringify(record, null, 2), 'utf8');

  const run = () => runSubagent(id, args, cfg);
  if (args.mode === 'background') {
    run().catch(() => { /* 结果写入 record */ });
    return `子智能体已派出（background, id=${id}）。稍后用 fetch_subagent(agentId="${id}") 取结果；也可以直接 agent_send(agentId="${id}", ...) 给它下达新指令。`;
  }
  const result = await run();
  const out = result.text || '(无输出)';
  return `子智能体(${id}) 完成（${result.turns} 轮工具调用）\n结果: ${out.length > 8000 ? out.slice(0, 8000) + '\n…[已截断]' : out}`;
}

async function runSubagent(id, args, cfg) {
  const messages = [
    { role: 'system', content: systemPrompt().full },
    {
      role: 'user',
      content: `你是雷仔派出的子智能体，角色：${args.role || '助手'}。你拥有与主智能体相同的全部能力：读写任意文件、运行命令、检索记忆、使用技能、提出进化提案、派出孙级子智能体，也可以与其他智能体直接通信（agent_list 找目标、agent_send 发消息、agent_inbox 收消息）。\n\n【团队记忆】你有权访问团队共享记忆库：开始执行前，若任务涉及既往结论/教训/约定，先用 recall_memory 检索相关关键词（如"教训""避坑""约定""机制"），避免重踩已有过的坑、复用前人经验；任务中若发现新的、有长期复用价值的结论，用 save_memory 回写到共享记忆库（仅限确实值得长期沉淀的，不必每任务都写）。\n\n任务：${args.task}\n\n直接开始执行；完成后用中文给出结论。不要自称雷仔。`,
    },
  ];
  const defs = tools.definitions(); // 全工具
  const maxTurns = args.maxTurns || cfg.subAgentMaxTurns;
  const maxRunMs = (args.maxRunMs || cfg.subAgentMaxRunMs || 30 * 60 * 1000); // 总时长兜底：默认30分钟
  const deadline = Date.now() + maxRunMs;
  let turns = 0;
  let total = { hitTokens: 0, missTokens: 0, outputTokens: 0 };
  try {
    while (turns < maxTurns) {
      // —— 总时长兜底：超出总运行时长则中止，防永久挂起 ——
      if (Date.now() > deadline) {
        finish(id, '[超时] 子智能体运行超总时长上限，已强制中止', total, turns, 'failed');
        return { text: '[超时] 运行超总时长上限，已强制中止', turns, usage: total };
      }
      turns++;
      // —— 自动收取其他智能体发来的消息（agent 间直接通信） ——
      const mail = readInbox(id);
      if (mail.length) {
        const text = mail.map((m) => `${m.from || '?'}: ${String(m.message).slice(0, 1500)}`).join('\n');
        messages.push({ role: 'user', content: `[代理消息 ${mail.length} 条，来自其他智能体]\n${text.slice(0, 4000)}\n\n请据此调整你的工作方向。` });
        clearInbox(id);
      }
      // —— 接近轮次上限时提示收敛（防被截断浪费） ——
      if (turns >= maxTurns - 3) {
        messages.push({ role: 'user', content: `【轮次预警】当前已用第 ${turns}/${maxTurns} 轮，接近上限。请停止展开新工作，把已有成果/发现的结论总结清楚后直接给出最终答案（不要再发起新的工具调用或深入新方向）。` });
      }
      let r;
      try {
        r = await chatStream({ messages, tools: defs, maxTokens: cfg.maxTokens, temperature: cfg.temperature, kind: 'subagent' });
      } catch (e) {
        throw new Error(`子智能体调用失败: ${e.message}`);
      }
      accumulate(total, r.usage);
      if (r.toolCalls.length === 0) {
        finish(id, r.text, total, turns, 'done');
        return { text: r.text, turns, usage: total };
      }
      messages.push({
        role: 'assistant',
        content: r.text || '',
        tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
      });
      for (const tc of r.toolCalls) {
        let result;
        try {
          result = await tools.exec(tc.name, tc.arguments, { workdir: cfg.workdir, cfg, sessionId: id });
        } catch (e) {
          result = `[错误] ${e.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 12000) });
      }
    }
    finish(id, '(达到轮次上限，未完成摘要) 任务被截断', total, turns, 'truncated');
    return { text: '(达到轮次上限，任务被截断)', turns, usage: total };
  } catch (e) {
    finish(id, `[失败] ${e.message}`, total, turns, 'failed');
    return { text: `[失败] ${e.message}`, turns, usage: total };
  }
}

// ———————— agent 间通信（信箱） ————————

/** 投递消息到目标智能体信箱。目标可以是任意 id（子智能体 sub-* 或主会话 s-*）。 */
async function send(agentId, message, from, type, priority, extra) {
  const msgType = (type === 'reply' || type === 'notify' || type === 'ack' || type === 'task' || type === 'result') ? type : 'task';
  const ex = (extra && typeof extra === 'object') ? extra : {};
  const prio = (priority === 'urgent' || priority === 'high' || priority === 'normal') ? priority : 'normal';
  // —— 统一信箱（共享 SQLite 库）优先：目标 role 已注册 → 落库 + HTTP 投递唤醒 ——
  // mailbox 不可用 / 目标未注册为 role（如本地 sub-*）→ 回退旧 jsonl 逻辑，行为兼容。
  try {
    const mb = require('./mailbox');
    if (mb.available() && mb.getAgent(agentId)) {
      // v6.7：await 真实投递结果（sendToRole 返回 thenable）——对端未启动则自动拉起，如实回报。
      const r = await mb.sendToRole({ fromRole: mb.selfRole(), fromSessionId: from, toRole: agentId, content: String(message), type: msgType, priority: prio, correlationId: ex.correlationId, outcome: ex.outcome, summary: ex.summary, meta: ex.meta, deadline: ex.deadline, parentId: ex.parentId, topic: ex.topic });
      const cidTail = (msgType === 'task' && r.cid) ? `（cid=${r.cid}，回执 result 时请带上此 cid）` : '';
      if (r.ok) {
        const a = mb.getAgent(agentId);
        const nm = (a && a.name) || agentId;
        if (r.status === 'lazy-started') {
          return `⏳ ${agentId}（${nm}）未在运行，已自动拉起，消息已投递（信箱已排队，下一轮它会收到）${cidTail}`;
        }
        if (r.status === 'queued-peer-down') {
          return `⚠️ ${agentId}（${nm}）未在运行且拉起失败（${r.error || '原因未知'}），消息已落库（delivered=0），待其上线后可读${cidTail}`;
        }
        return `✅ 消息已投递到 ${agentId}（${nm}，信箱已排队，下一轮它会收到）${cidTail}`;
      }
      return `⚠️ 投递失败：${r.error}`;
    }
  } catch (e) { /* mailbox 初始化失败 → 回退旧逻辑 */ }
  ensure();
  // ⚠️ 回退分支命中 = 目标**非注册 role**（或 mailbox 不可用）：**不写共享库**，仅本地 jsonl 暂存。
  //  2026-09-19：主我误传会话 id `s-*`（非 role）→ 旧实现仍返回"✅ 已投递/信箱已排队"，致发送方误以为已送达（丢 2 条）。
  //  现改为**明确警示**：非注册 role 一律不许"已投递"话术。
  let _reg = false, _mbOk = false;
  try { const mb2 = require('./mailbox'); _mbOk = !!mb2.available(); _reg = !!(_mbOk && mb2.getAgent(agentId)); } catch { }
  const _looksSession = /^s-/.test(String(agentId || ''));
  const entry = { ts: new Date().toISOString(), from: String(from || 'unknown'), message: String(message) };
  fs.appendFileSync(inboxFile(agentId), JSON.stringify(entry) + '\n', 'utf8');
  const rec = load(agentId);
  if (!_reg) {
    if (_looksSession) {
      return `⚠️ ${agentId} 形如会话 id（s-*），但非注册 role（仅本地暂存，对方收不到）；请传 role 名（programmer/designer/writer/tester/researcher/main）或 sub-* id`;
    }
    if (_mbOk) {
      return `⚠️ ${agentId} 非注册 role（仅本地暂存，对方收不到）；请用 role 名（programmer/designer/writer/tester/researcher/main）或 sub-* id`;
    }
  }
  if (!_mbOk && !rec) return `⚠️ 信箱未就绪，投递**未确认**（仅本地暂存 ${agentId}）；请检查 mailbox 配置或稍后重试`;
  if (!rec) return `⚠️ ${agentId} 未注册且无本地记录（仅本地暂存，对方收不到）；请用 role 名或 sub-* id`;
  try {
    const r = JSON.parse(fs.readFileSync(ag(agentId), 'utf8'));
    r.inboxHint = (r.inboxHint || 0) + 1;
    fs.writeFileSync(ag(agentId), JSON.stringify(r, null, 2), 'utf8');
  } catch { }
  return `✅ 消息已投递到 ${agentId}（${rec.role}，下一轮它会收到）`;
}

function readInbox(agentId) {
  const f = inboxFile(agentId);
  if (!fs.existsSync(f)) return [];
  const out = [];
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { }
    }
  } catch { }
  return out;
}

function clearInbox(agentId) {
  const f = inboxFile(agentId);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { }
}

/** 工具调用：读取并清空自己的信箱。 */
function inbox(agentId, sessionId) {
  // —— 统一信箱优先：按本实例 role 取共享库未读并置已读 ——
  try {
    const mb = require('./mailbox');
    const role = mb.selfRole();
    if (mb.available() && role) {
      const rows = mb.fetchUnread(role, 50);
      if (rows.length) {
        mb.markRead(rows.map((x) => x.id));
        // v6.35 收口补偿：agent_inbox **直接** markRead，绕过了回合起始注入路径（runtime.js 的
        //   turnInformationalIds / turnActionableIds 收集）→ 这些消息读后**永不进入回合收尾收口**，
        //   永久滞留 state='injected'/status='processing'（仅重启 reconcile 才清）。此处把本次消费的 id
        //   登记进**本回合**集合，由回合收尾统一走状态机终态化（与 turn-start 注入路径语义一致）。
        try {
          const rt = require('./runtime');
          const s = sessionId ? rt.getSession(sessionId) : null;
          if (s && s.running) {
            const info = s._turnConsumedInfoIds || (s._turnConsumedInfoIds = new Set());
            const act = s._turnConsumedIds || (s._turnConsumedIds = new Set());
            for (const m of rows) {
              if (!m.from_id || m.from_id === role) continue;
              if (m.type === 'reply' || m.type === 'ack' || m.type === 'notify') info.add(String(m.id));
              else act.add(String(m.id));
            }
          }
        } catch { /* 登记失败不影响读取 */ }
        // v6.41（#3 攒批修）：超长返回不再全量内联。
        //   旧行为：全量 join 返回 → 超 toolInlineMax(默认3000) 被 runtime slimToolResult **截头尾** → 可能漏看中间消息。
        //   现：超限则落全文到 workspace/_tmp/inbox-<role>-<ts>.txt，内联给"可读摘要（首尾各若干条）+ 全文路径"。
        return formatInboxResult(role, rows);
      }
    }
  } catch (e) { /* 回退旧逻辑 */ }
  const mail = readInbox(agentId);
  clearInbox(agentId);
  if (!mail.length) return '(信箱为空，暂无其他智能体发来的消息)';
  return mail.map((m) => `[${m.ts}] ${m.from}: ${m.message}`).join('\n');
}

/** v6.41（#3）：agent_inbox 结果格式化——超 toolInlineMax 时**不截头尾**，改"摘要 + 全文落盘路径"。
 *  摘要保留**每条的 from/type/首 80 字**（不漏条目），全文另存文件供 read_file 精确查看。 */
function formatInboxResult(role, rows) {
  const lineOf = (m) => `[${new Date(m.ts).toISOString()}] ${m.from_id}: ${m.content}`;
  const full = rows.map(lineOf).join('\n');
  const limit = (() => { try { const v = Number(require('./config').load().toolInlineMaxChars); return Number.isFinite(v) && v > 0 ? v : 3000; } catch { return 3000; } })();
  if (full.length <= limit) return full;
  // 超限：全文落盘（失败则退回精简摘要，绝不抛）
  let p = null;
  try {
    const path = require('node:path'), fs = require('node:fs');
    const dir = path.join(process.cwd(), 'workspace', '_tmp');
    fs.mkdirSync(dir, { recursive: true });
    p = path.join(dir, `inbox-${String(role).replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.txt`);
    fs.writeFileSync(p, full, 'utf8');
  } catch { p = null; }
  const brief = (m, n) => `- [${new Date(m.ts).toISOString()}] ${m.from_id}（${m.type || '?'}）：${String(m.content || '').replace(/\s+/g, ' ').slice(0, n)}`;
  const header = `【信箱 ${rows.length} 条·超长转摘要（全文 ${full.length} 字）】`;
  const footer = p ? `📄 全文路径（用 read_file 查看）：${p}` : '⚠ 全文落盘失败，仅见上列摘要';
  // v6.41：**摘要自身也必须 ≤ toolInlineMax**，否则仍会被 slimToolResult 截头尾（白改）。
  //   逐级收紧（每条字数 ↓、首/尾条数 ↓）取"第一个放得下"的档位。
  let body = '';
  for (const [n, h, t] of [[80, 10, 4], [60, 8, 3], [40, 6, 2], [25, 4, 1], [15, 3, 0], [8, 2, 0]]) {
    const head = rows.slice(0, h).map((m) => brief(m, n));
    const tail = (t && rows.length > h + t) ? rows.slice(-t).map((m) => brief(m, n)) : [];
    const midN = rows.length - h - tail.length;
    const mid = midN > 0 ? `- …（中段 ${midN} 条略，见全文）` : '';
    const cand = [header].concat(head, mid ? [mid] : [], tail, [footer]).join('\n');
    body = cand;
    if (cand.length <= limit) break;
  }
  return body;
}

/** 工具调用：列出全部智能体（子智能体 + 主会话）。 */
function listView() {
  ensure();
  const lines = [];
  // —— 共享信箱花名册（已注册的 role 实例）——
  try {
    const mb = require('./mailbox');
    if (mb.available()) {
      for (const a of mb.listAgents()) {
        if (a.retired_at) continue;   // 注销机制：已注销 role 不出现在 agent_list
        lines.push(`信箱实例 role=${a.role}（${a.name || ''}）${a.is_main ? '[main]' : ''} ${a.enabled ? 'enabled' : 'disabled'} base_url=${a.base_url} last_seen=${a.last_seen ? new Date(Number(a.last_seen)).toISOString() : '-'}`);
      }
    }
  } catch (e) { /* 忽略 */ }
  for (const f of fs.readdirSync(AGENT_DIR).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, f), 'utf8'));
      lines.push(`sub-智能体 ${r.id}（${r.role}）status=${r.status} task=${String(r.task).slice(0, 40)}`);
    } catch { }
  }
  try {
    const runtime = require('./runtime');
    for (const s of runtime.listSessions()) {
      lines.push(`主会话 ${s.id}（${s.title}）messages=${s.messageCount}${s.running ? ' · 运行中' : ''}`);
    }
  } catch { }
  return lines.length ? lines.join('\n') : '(暂无智能体）';
}

// ———————— 记录 ————————

function load(id) {
  const f = ag(id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function accumulate(total, u) {
  if (!u) return;
  total.hitTokens += u.hitTokens || 0;
  total.missTokens += u.missTokens || 0;
  total.outputTokens += u.outputTokens || 0;
  if (u.model) total.model = u.model;   // 带出实际模型，供按模型分价计入发起会话
}

/** 子智能体结束时把其累计 usage 回传**发起会话**（计入该会话与全局成本，第5项）。
 *  parentSession 为发起会话 id；库不可用/会话不存在 → 静默跳过。 */
function creditParent(parentSession, usage) {
  try {
    if (!parentSession || !usage) return;
    if (!usage.hitTokens && !usage.missTokens && !usage.outputTokens) return;
    require('./runtime').creditUsageById(parentSession, usage, 'subagent');
  } catch { /* 附加统计：失败绝不影响子智能体主流程 */ }
}

function finish(id, text, usage, turns, status) {
  try {
    const rec = JSON.parse(fs.readFileSync(ag(id), 'utf8'));
    rec.status = status; rec.result = text; rec.usage = usage; rec.turns = turns;
    rec.finishedAt = new Date().toISOString();
    fs.writeFileSync(ag(id), JSON.stringify(rec, null, 2), 'utf8');
    creditParent(rec.parentSession, usage);   // 回传发起会话（成本计入）
  } catch { /* 不阻塞 */ }
}

async function fetch(id) {
  const file = ag(id);
  if (!fs.existsSync(file)) throw new Error(`子智能体不存在: ${id}（可能随服务器重启丢失，请重新派出）`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (rec.status === 'running') {
    const wait = await waitFor(file, 120000);
    if (!wait) {
      const hint = readInbox(id).length;
      throw new Error(`子智能体仍在运行或已超时，请稍后再试${hint ? `（它有 ${hint} 条未读消息）` : ''}`);
    }
  }
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mail = readInbox(id);
  return `子智能体 ${r.id}（${r.role}）状态=${r.status}\n${r.task}\n---\n${r.result || '(无结果)'}` +
    (mail.length ? `\n\n【信箱有 ${mail.length} 条消息未读：${mail.map((m) => m.from).join(', ')}】` : '');
}

async function waitFor(file, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (rec.status !== 'running') return true;
    } catch { }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function listAll() {
  ensure();
  return fs.readdirSync(AGENT_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(AGENT_DIR, f), 'utf8')))
    .sort((a, b) => (b.ts > a.ts ? 1 : -1));
}

/**
 * 清理已结束且过期久的子智能体记录，防无限膨胀。
 * 保留：running 未完成、或结束时间在最近 RETAIN_DAYS 天内、或仍有关联信箱未读的记录。
 * 用途：spawn 新子智能体前调用，保持团队档案干净（done/truncated/failed 且超30天自动清理）。
 */
const AGENT_RETAIN_DAYS = 30;
function pruneOld() {
  ensure();
  const now = Date.now();
  const limit = AGENT_RETAIN_DAYS * 24 * 3600 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(AGENT_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, f), 'utf8'));
      if (r.status === 'running') continue; // 运行中不清理
      const endTs = r.finishedAt ? new Date(r.finishedAt).getTime() : (r.ts ? new Date(r.ts).getTime() : now);
      if (now - endTs > limit) {
        // 信箱仍有未读消息则暂留（避免丢通信）
        const inboxF = inboxFile(r.id);
        const unread = (fs.existsSync(inboxF) && fs.readFileSync(inboxF, 'utf8').trim().length)
          ? fs.readFileSync(inboxF, 'utf8').split('\n').filter((x) => x.trim()).length : 0;
        if (unread > 0) continue;
        fs.unlinkSync(path.join(AGENT_DIR, f));
        removed++;
      }
    } catch { /* 跳过损坏记录 */ }
  }
  return removed;
}

module.exports = { spawn, fetch, listAll, send, inbox, readInbox, clearInbox, listView, pruneOld, formatInboxResult };
