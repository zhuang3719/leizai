'use strict';
// 雷仔 · 统一信箱（通讯方案 v5 · 共享 SQLite 库）
// —— 单模块收敛全部新逻辑：连接/建表/自注册/收发/会话映射/投递。
// 硬约束（见《主引擎改动执行说明书_交程序员.md》）：
//  1) 本模块内**绝不出现任何具体角色名常量**（'main'/'programmer' 等），一律按 role 变量走表查询；
//  2) PRAGMA journal_mode=WAL **只由主引擎（isMain）设一次**；其他实例只设 busy_timeout；
//  3) 非文本产物/消息一律落库，投递失败也不能丢消息（delivered=0，等对端上线读）；
//  4) 未注册 role 返回明确错误，不静默失败。
//
// 设计要点：
// - 库文件路径来自 config.agentSharedDb（4 实例必须一致）。
// - 消息四态：pending | processing | done | failed；read_at/replied_at 两个时间戳刻画"已读/已回"。
// - 会话映射 session_links 懒创建：自注册≠建会话；只有某主会话第一次与某 role 通讯时才建映射/对端会话。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn: childSpawn } = require('node:child_process');
const { load: loadConfig } = require('./config');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { /* 旧 Node 无内置 sqlite → 全局回退旧信箱 */ }

let db = null;
let inited = false;
let _isMain = false;

// ———————— P2a：引擎注入 hook（切断 mailbox → runtime 反向依赖，M35）————————
// 通讯层不得反向 require runtime（ADR §2.0 独立化总原则）。所需引擎能力（事件广播 / 会话存在性 /
//   空会话清扫）改由引擎启动时经 setHooks() 注入；未注入时安全降级为 no-op。
const _hooks = { emit: null, sessionExists: null, sweepEmptyPeerSessions: null };
/** P2b-4：最近一次 sendMessage 的版本元数据（供 _sendPrep 判定是否修订→触发接收方 abort）。 */
const _sendMeta = new Map();
function takeSendMeta(id) { try { const v = _sendMeta.get(String(id)); _sendMeta.delete(String(id)); return v || null; } catch { return null; } }
function setHooks(h) {
  if (!h || typeof h !== 'object') return;
  for (const k of Object.keys(_hooks)) { if (typeof h[k] === 'function') _hooks[k] = h[k]; }
}

// ———————— 基础：开关 / 路径 / 自识 ————————

function cfg() { try { return loadConfig(); } catch { return {}; } }
function enabled() { const c = cfg(); return c.mailboxEnabled !== false; }
function available() { return inited && !!db; }
function dbPath() {
  // 测试隔离钩子：LEIZAI_AGENT_DB 显式指定共享库路径（仅测试用；默认不设=原行为不变）。
  // 背景：config.json 显式写了 agentSharedDb，LEIZAI_DATA_DIR 无法覆盖它 → 单测会误写生产库。
  if (process.env.LEIZAI_AGENT_DB) return process.env.LEIZAI_AGENT_DB;
  const c = cfg();
  return c.agentSharedDb || path.join(c.dataDir || path.join(__dirname, '..', 'data'), 'agents_shared.db');
}
/** 本实例自身 role（来自 config.agent.role）；未配置返回 null。 */
function selfRole() { const a = cfg().agent; return (a && a.role) ? String(a.role) : null; }

// ———————— 连接与初始化 ————————

/**
 * 初始化连接 + 建表。
 * @param {{isMain?:boolean}} opts 只有主引擎传 {isMain:true}
 */
function init(opts = {}) {
  if (db) return db;
  if (!enabled()) return null;
  if (!DatabaseSync) { console.error('[mailbox] 当前 Node 无 node:sqlite，已回退旧信箱'); return null; }
  const p = dbPath();
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { }
  db = new DatabaseSync(p);
  // 所有实例：只设 busy_timeout（并发写不立即报 locked，先等待）
  db.exec('PRAGMA busy_timeout = 5000;');
  _isMain = !!opts.isMain;
  if (opts.isMain) {
    // ★ WAL 只由主引擎设一次；WAL 持久化在库文件里，其他实例打开即为 WAL，无需重复设。
    try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) { console.error('[mailbox] 设置 WAL 失败:', e.message); }
  }
  ensureSchema();
  inited = true;
  // v6.9：启动即补标一次「陈年非动作类」未读（防历史脏数据让顶栏角标常驻）。
  try { markAgedNonActionRead(); } catch { }
  // v6.10：启动对账「回合被进程杀/重启打断」的入站消息（补回写缺口兜底，防假待办续跑循环）。
  try { const _rc = reconcileInterruptedInbound(); if (_rc) console.error(`[mailbox] 启动对账：处理 ${_rc} 条被中断的入站消息`); } catch { }
  // P1 §三.7：存量收敛——把 reply/ack/notify 类非终态行收敛（V5：存量 processing 目标 0）。
  try { const _cv = sweepConvergeLegacy(); if (_cv) console.error(`[mailbox] 存量收敛：处理 ${_cv} 条信息类滞留`); } catch { }
  // P1 遗留3：state/status 双写一致性修正（status 已终态但 state 非终态 → 补 state 终态；判据 SQL 归零）。
  try { const _ss = reconcileStateStatus(); if (_ss) console.error(`[mailbox] state/status 一致性修正：${_ss} 条`); } catch { }
  // D 兜底：启动后延迟清扫本实例内超期的空"信箱会话"（软删可恢复；config.mailboxSweepEmpty=false 可关）。
  // 仅清扫本实例会话文件，绝不跨实例；能力由引擎经 setHooks 注入（P2a：切断反向依赖，M35）。
  try {
    if (!init._sweepScheduled) {
      init._sweepScheduled = true;
      setTimeout(() => { try { if (cfg().mailboxSweepEmpty !== false && typeof _hooks.sweepEmptyPeerSessions === 'function') _hooks.sweepEmptyPeerSessions({}); } catch { } }, 15000);
    }
  } catch { }
  return db;
}

/** 幂等建表（可在任一路径执行；journal_mode 仍只在 isMain 设）。 */
function ensureSchema() {
  if (!db) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  role TEXT PRIMARY KEY, name TEXT, base_url TEXT NOT NULL, domain TEXT, data_dir TEXT,
  capabilities TEXT, is_main INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
  last_seen INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  from_session_id TEXT, to_session_id TEXT, topic TEXT,
  type TEXT NOT NULL DEFAULT 'task', content TEXT NOT NULL,
  ts INTEGER NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
  read_at INTEGER, replied_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_msg_to   ON agent_messages(to_id, read_at, ts);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON agent_messages(from_id, to_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_ts   ON agent_messages(ts);
CREATE TABLE IF NOT EXISTS session_links (
  id TEXT PRIMARY KEY, main_session_id TEXT NOT NULL, peer_role TEXT NOT NULL,
  peer_session_id TEXT NOT NULL, peer_base_url TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(main_session_id, peer_role));
`);
  // v5.7：主实例调度会话（承载所有雷影→main 消息）。ALTER 幂等：列已存在则忽略。
  try { db.exec('ALTER TABLE agents ADD COLUMN dispatcher_session_id TEXT;'); } catch { }
  // 注销机制：retired_at 墓碑字段（非空=已注销，防复活）。ALTER 幂等：列已存在则忽略。
  try { db.exec('ALTER TABLE agents ADD COLUMN retired_at INTEGER;'); } catch { }
  // v6.4：busy 指示器根治——agents 表记录该实例"正在跑回合"的真实状态。ALTER 幂等：列已存在则忽略。
  try { db.exec('ALTER TABLE agents ADD COLUMN busy_session TEXT;'); } catch { }
  try { db.exec('ALTER TABLE agents ADD COLUMN busy_at INTEGER;'); } catch { }
  // P0②（ADR-0005 v10 §2.1.2 规则5）：wake_intent 枚举列 {none|actionable}，默认 none。
  // 用于让本属非动作类(notify)的消息（如 task-state done）显式获得唤醒能力。ALTER 幂等：列已存在则忽略。
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN wake_intent TEXT;'); } catch { }
  // P2（R3·2026-09-29）：拆 wake_intent 语义——notify_target（发送侧·唤醒意图 actionable/null）+ is_pending（接收侧·是否待办 1/0）。
  //   wake_intent 保留为**派生/兼容列**（不删，保回滚）；写入侧三列同步。
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN notify_target TEXT;'); } catch { }
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN is_pending INTEGER;'); } catch { }
  // 存量回填（仅新列 IS NULL 的行；幂等）。
  try {
    db.prepare("UPDATE agent_messages SET notify_target = CASE WHEN wake_intent='actionable' THEN 'actionable' ELSE NULL END WHERE notify_target IS NULL").run();
    db.prepare(`UPDATE agent_messages SET is_pending = CASE
        WHEN type IN ('reply','ack','notify') THEN 0
        WHEN type = 'result' THEN (CASE WHEN wake_intent='actionable' THEN 1 ELSE 0 END)
        ELSE 1 END WHERE is_pending IS NULL`).run();
  } catch (e) { try { console.error('[mailbox] notify_target/is_pending 回填失败:', e.message); } catch { } }
  // P2a（ADR-0005 v10.1 §2.8.1）：关单地基列（附加式，幂等 ADD COLUMN）——列已存在则忽略。
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN correlation_id TEXT;'); } catch { }
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN rev INTEGER;'); } catch { }
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN supersedes TEXT;'); } catch { }
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN deadline INTEGER;'); } catch { }
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN parent_id TEXT;'); } catch { }
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN meta TEXT;'); } catch { }
  // P0(b)：收口提醒已发时间戳（幂等 ALTER）——awaiting_close 任务催办"只发一次"的判据。
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN close_nudged_at INTEGER;'); } catch { }
  // v6.30（2026-09-29）：系统通知标记列——超期通知/收口催办等"系统自动生成"的 result 置 1，
  //   使其**不占用"该 cid 首个 result"唤醒名额**（否则超期通知先到 → 真完成回执被 prior 判据吞掉 → 发起方收不到"真完成"）。
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN sys_notice INTEGER DEFAULT 0;'); } catch { }
  // v6.31（2026-09-29·彻底版）：唤醒幂等位——以 cid 为键记录"是否已唤醒过"（与 replied_at/status 关单态**解耦**）。
  //   notified_at = 真终态回执已唤醒时间；sys_notified_at = 系统通知最近唤醒时间（独立限频，不占 notified_at）。
  try { db.exec(`CREATE TABLE IF NOT EXISTS task_wake_log (
      cid TEXT PRIMARY KEY, notified_at INTEGER, sys_notified_at INTEGER);`); } catch { }
  // v6.47（2026-09-30）：唤醒"已投递/未真起回合"拆位——notified_at=决策(已通知)；woke_at=接收侧**真起回合消费**时间。
  //   用途：主我 busy 时回执被判"已通知"却未起回合 → sweep 扫 notified_at 非空 && woke_at 空 者补唤醒（治"回执到了没反应"）。
  try { db.exec('ALTER TABLE task_wake_log ADD COLUMN woke_at INTEGER;'); } catch { }
  // v6.53（2026-09-30）：知情类回执「空闲兜底唤醒」幂等位——按 msg_id 记"已兜底提醒过"（同批只提醒一次，被消费后不再提醒）。
  //   治：reply/ack/notify 无 cid 且无 open task 时永不唤醒 → 主我漏收回执（实测 m-muo8el3o）。
  try { db.exec('CREATE TABLE IF NOT EXISTS silent_wake_log (msg_id TEXT PRIMARY KEY, notified_at INTEGER);'); } catch { }
  // GAP-2：retention 冷表——归档表结构与主表一致（仅存超期已闭环行；主表删除）。
  try { db.exec('CREATE TABLE IF NOT EXISTS agent_messages_archive AS SELECT * FROM agent_messages WHERE 0;'); } catch { }
  // 关单索引：correlation_id 需走索引做 UPDATE…WHERE correlation_id=?（前缀/blob 无法走索引）。
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_msg_cid ON agent_messages(correlation_id, rev);'); } catch { }
  // P2b-4：幂等键 UNIQUE(from,to,cid,type,rev)（ADR H1）——部分唯一索引，仅对含 cid+rev 的行生效。
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg_idem ON agent_messages(from_id,to_id,correlation_id,type,rev) WHERE correlation_id IS NOT NULL AND rev IS NOT NULL;"); } catch { }
  // P1（R5·2026-09-29）：幂等键升级——原部分索引 `WHERE rev IS NOT NULL` 有洞（rev=NULL 的行不受约束，
  //   同 cid 无 rev 可重复落库）。新键用 COALESCE(rev,0) 覆盖 NULL。先建新键成功再删旧键（失败回退保旧键）。
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg_idem_v2 ON agent_messages(from_id,to_id,correlation_id,type,COALESCE(rev,0)) WHERE correlation_id IS NOT NULL;");
    try { db.exec('DROP INDEX IF EXISTS uniq_msg_idem;'); } catch { }
  } catch (e) { try { console.error('[mailbox] 幂等键升级失败(疑存量重复，保留旧键):', e.message); } catch { } }
  // P1（R1·2026-09-29）：消息生命周期**单一状态列** state（inbox→injected→consumed→closed；终态 closed/expired/failed）。
  //   与旧 status 双写（灰度 mailboxStateMachine）；injected_at 持久化"已注入"（治 R2 双通道重复注入）。
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN state TEXT;'); } catch { }
  try { db.exec('ALTER TABLE agent_messages ADD COLUMN injected_at INTEGER;'); } catch { }
  // 存量回填 state（仅 state IS NULL 的行；幂等）。
  try {
    db.prepare(`UPDATE agent_messages SET state = CASE
        WHEN status='pending' THEN 'inbox'
        WHEN status='processing' THEN 'injected'
        WHEN status IN ('done','closed','cancelled','superseded','awaiting_close') THEN 'closed'
        WHEN status IN ('stale','expired') THEN 'expired'
        WHEN status='failed' THEN 'failed'
        ELSE 'inbox' END
      WHERE state IS NULL`).run();
  } catch (e) { try { console.error('[mailbox] state 回填失败:', e.message); } catch { } }
  // 存量回填（§2.8.1）：**仅未闭环 task** 生成 correlation_id='legacy-<id>'、rev 留 NULL；已闭环留 NULL。
  //   幂等：只填 correlation_id IS NULL 的行，重复启动不重复回填。
  try {
    db.prepare("UPDATE agent_messages SET correlation_id='legacy-'||id WHERE type='task' AND replied_at IS NULL AND correlation_id IS NULL").run();
  } catch { }
}

function nowMs() { return Date.now(); }
function newId(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`; }

// ———————— 花名册 ————————

/** UPSERT 自注册 + 刷新 last_seen。agentCfg: {role,name,domain,baseUrl,isMain,capabilities} */
function registerAgent(agentCfg, dataDir) {
  if (!db || !agentCfg || !agentCfg.role) return null;
  // 注销防复活：已注销（retired_at 非空）→ 拒绝自注册，不复活
  try { const ex = getAgent(agentCfg.role); if (ex && ex.retired_at) return null; } catch { }
  const now = nowMs();
  db.prepare(`INSERT INTO agents
      (role,name,base_url,domain,data_dir,capabilities,is_main,enabled,last_seen,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(role) DO UPDATE SET
        name=excluded.name, base_url=excluded.base_url, domain=excluded.domain, data_dir=excluded.data_dir,
        capabilities=excluded.capabilities, is_main=excluded.is_main,
        enabled=CASE WHEN agents.retired_at IS NOT NULL THEN 0 ELSE 1 END,
        last_seen=excluded.last_seen, updated_at=excluded.updated_at`)
    .run(agentCfg.role, agentCfg.name || agentCfg.role, agentCfg.baseUrl ? String(agentCfg.baseUrl) : '',
      agentCfg.domain || '', dataDir || '', agentCfg.capabilities ? JSON.stringify(agentCfg.capabilities) : null,
      agentCfg.isMain ? 1 : 0, 1, now, now, now);
  try { setAgentBusy(agentCfg.role, null); } catch { }   // v6.30：启动即清本 role 的 busy 残留（重启不会走 turn finally），并 emit/转发 busy=false 复位前端
  return getAgent(agentCfg.role);
}

function getAgent(role) {
  if (!db || !role) return null;
  return db.prepare('SELECT * FROM agents WHERE role = ?').get(String(role)) || null;
}

// v5.7：主实例调度会话读写（承载所有雷影→main 消息）
function getDispatcher(role) { if (!db || !role) return null; const a = getAgent(role); return (a && a.dispatcher_session_id) ? String(a.dispatcher_session_id) : null; }
function setDispatcher(role, sid) { if (!db || !role) return; db.prepare('UPDATE agents SET dispatcher_session_id=?, updated_at=? WHERE role=?').run(sid ? String(sid) : null, nowMs(), String(role)); }

/** v6.4：上报本实例"正在跑回合"的真实状态。sessionId 为空 → 置空闲（busy_session=NULL, busy_at=NULL）。
 *  与启发式（lastTs/活跃窗口）不同，这是**准确信号**：雷影回合开始置忙、finally 收尾置空；TTL 兜底防崩溃卡死。 */
function setAgentBusy(role, sessionId, opts = {}) {
  if (!db || !role) return;
  const sid = sessionId ? String(sessionId) : null;
  db.prepare('UPDATE agents SET busy_session=?, busy_at=?, updated_at=? WHERE role=?')
    .run(sid, sid ? nowMs() : null, nowMs(), String(role));
  try { if (typeof _hooks.emit === 'function') _hooks.emit('agent-busy', { role:String(role), busy:!!sid, sessionId:sid }); } catch {}
  // A：跨实例转发——各雷影实例的本地 broadcast 前端收不到（SSE 只连主引擎），故非 main 实例主动 POST 给主引擎。
  //   ★防自环（2026-09-29 紧急）：①opts.noForward（主引擎 busy-notify 端点落库时用，只写库不转发）；
  //   ②仅当**本实例自身 role ≠ 'main'** 才转发（主引擎永不转发，杜绝"端点调 setAgentBusy → 又 POST 自己"回环）。
  try {
    if (!opts.noForward && String(selfRole() || '') !== 'main' && String(role) !== 'main') {
      const m = getAgent('main');
      if (m && m.base_url) {
        fetch(`${m.base_url}/api/agent/busy-notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: String(role), busy: !!sid, sessionId: sid }),
        }).catch(() => {});
      }
    }
  } catch {}
}

/** P2b-2：信箱消费/回复事件的跨实例转发 + 本地广播。
 *  仅供前端"上屏点亮"（涟漪流），**绝不触发任何唤醒**——广播是纯 SSE 写，不调 runChat/wakeMailbox。
 *  非 main 实例本地 broadcast 前端收不到（SSE 只连主引擎）→ 主动 POST 给主引擎由其统一广播。 */
function emitMailboxEvent(event, payload) {
  try { if (typeof _hooks.emit === 'function') _hooks.emit(event, payload); } catch {}
  try {
    const role = selfRole();
    if (role && role !== 'main') {
      const m = getAgent('main');
      if (m && m.base_url) {
        fetch(`${m.base_url}/api/agent/mailbox-event`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role, event, payload }),
        }).catch(() => {});
      }
    }
  } catch {}
}

/** v7（busy 心跳）：活跃回合中**续约** busy_at（仅刷新时间戳，不 emit / 不跨实例广播——
 *  避免每轮迭代高频刷屏）。与 setAgentBusy 配对：回合开始置忙、每轮/长工具中续约、finally 置空。
 *  WHERE busy_session IS NOT NULL：只续约"确实在忙"的行，已置空闲者不动（防误触）。 */
function touchAgentBusy(role) {
  if (!db || !role) return;
  try {
    db.prepare('UPDATE agents SET busy_at=?, updated_at=? WHERE role=? AND busy_session IS NOT NULL')
      .run(nowMs(), nowMs(), String(role));
  } catch {}
}

/** v6.31：busy 单入口状态机——置忙/置闲（内部即 setAgentBusy；全仓 busy 变更统一走这两个入口）。 */
function setBusy(role, sessionId) { return setAgentBusy(role, sessionId); }
function clearBusy(role) { return setAgentBusy(role, null); }

function listAgents() {
  if (!db) return [];
  // 统一排除已注销（retired_at 非空）→ 不出现在 /api/agents、agent_list、revive 扫描
  try { return db.prepare('SELECT * FROM agents WHERE retired_at IS NULL ORDER BY is_main DESC, role ASC').all(); }
  catch { try { return db.prepare('SELECT * FROM agents ORDER BY is_main DESC, role ASC').all(); } catch { return []; } }   // 旧库缺列 → 优雅降级
}

/** 注销雷影（不删行）：写库 enabled=0 + retired_at=now。@returns {ok,role,base_url,error?} */
function retireAgent(role) {
  if (!db || !role) return { ok: false, error: '需要 role' };
  const a = getAgent(String(role));
  if (!a) return { ok: false, error: `未注册角色：${role}` };
  if (a.is_main) return { ok: false, error: '不可注销主实例' };
  db.prepare('UPDATE agents SET enabled=0, retired_at=?, updated_at=? WHERE role=?').run(nowMs(), nowMs(), String(role));
  // 收尾完善：一并清理该 role 的会话映射（否则 revive 后会复用旧 link；纯 SQL，不删对端会话文件）。
  // 异常安全：清理失败不影响注销主流程（只写墓碑已足够保证投递被拒）。
  try { db.prepare('DELETE FROM session_links WHERE peer_role=?').run(String(role)); } catch { }
  return { ok: true, role: String(role), base_url: a.base_url || '' };
}

/** 恢复雷影（清墓碑）：enabled=1 + retired_at=NULL。@returns {ok,role,error?} */
function reviveAgent(role) {
  if (!db || !role) return { ok: false, error: '需要 role' };
  const a = getAgent(String(role));
  if (!a) return { ok: false, error: `未注册角色：${role}` };
  db.prepare('UPDATE agents SET enabled=1, retired_at=NULL, updated_at=? WHERE role=?').run(nowMs(), String(role));
  return { ok: true, role: String(role) };
}

function touchLastSeen(role) {
  if (!db || !role) return;
  db.prepare('UPDATE agents SET last_seen=?, updated_at=? WHERE role=?').run(nowMs(), nowMs(), String(role));
}

// ———————— 消息 ————————

/** P1a（ADR-0005 v10 §2.5 无环不变式 / P1 过渡档）：应答唤醒发起方（启发式，无 cid）。
 *  发送 **reply** 时，若发送方(replier) 存在**来自目标方(target) 的未回执 inbound task**，
 *  则**原子关单**该 task（仅最近一条；`UPDATE … WHERE replied_at IS NULL`，靠 `changes==1` 防并发），
 *  并返回 true → 调用方给本 reply 置 `wake_intent='actionable'`，使**发起方被唤醒一次**。
 *  去重：同一 task 首次命中即关单，后续同 task 的 reply 找不到 open task → 不再唤醒（W-B）。
 *  防放大：无 open task 时返回 false → 不唤醒（W-C）。仅启发式，P2b 换 cid 精确。 */
function consumeInboundTaskForReply(replierRole, targetRole) {
  if (!db) return false;
  // P2b-11 歧义保守：同 (from,to) 存在 ≥2 条未回 task 时，无法判定回执针对哪一条 →
  //   不自动关单（宁可不关，绝不误关；漏关可由发起方/超时兜底）。仅当**恰有 1 条**才关。
  try {
    const open = db.prepare(`SELECT id, from_id, to_id, meta FROM agent_messages
        WHERE from_id=? AND to_id=? AND type='task' AND replied_at IS NULL
        ORDER BY ts DESC`).all(String(targetRole), String(replierRole));
    if (open.length !== 1) return false;   // 0=无单可关；≥2=歧义保守，不误关
    const row = open[0];
    // P0(b)：需收口类 → 置 awaiting_close（非终态）而非 closed；仍置 replied_at 保证去重。
    let nc = false; try { const mm = row.meta ? JSON.parse(String(row.meta)) : null; nc = !!(mm && mm.needsCallerClose); } catch { }
    const target = nc ? 'awaiting_close' : 'closed';
    const n = advance(String(row.id), nc ? 'replyAwait' : 'reply', { now: nowMs(), onlyIf: 'replied_at IS NULL' }).changes;
    if (Number(n) === 1 && nc && row.from_id) {
      try {
        sendMessage({ from: String(row.to_id), to: String(row.from_id), type: 'result',
          correlationId: String(row.id), outcome: 'done',
          content: `任务 ${row.id} 我方已完成，待你收口（部署/重启）。` });
      } catch { }
    }
    return Number(n) === 1;
  } catch { return false; }
}

/** P2b-12：把可能是"短码(末8位)"的 cid 补全为完整 correlation_id。
 *  在 (task.from=to, task.to=from) 收发对内：先精确匹配，失败则后缀 LIKE 匹配；都无 → null。
 *  from/to 语义：task 的 from_id=本 result 的接收方(m.to)，to_id=本 result 的发送方(m.from)。 */
function resolveFullCid(tok, from, to) {
  if (!db || !tok) return null;
  try {
    const t = String(tok);
    const base = `SELECT correlation_id FROM agent_messages
        WHERE from_id=? AND to_id=? AND type='task' AND correlation_id IS NOT NULL`;
    let r = db.prepare(base + ` AND correlation_id=? LIMIT 1`).get(String(to), String(from), t);
    if (r && r.correlation_id) return String(r.correlation_id);
    r = db.prepare(base + ` AND correlation_id LIKE ? ORDER BY ts DESC LIMIT 1`).get(String(to), String(from), '%' + t);
    if (r && r.correlation_id) return String(r.correlation_id);
  } catch { }
  return null;
}

// ———————— P2b-1：cid 精确原子关单 + 状态机终态（ADR §2.4）————————
// 终态集合（单调不可逆）：进入任一终态后，同 cid 的 rev/result 一律 ignore（不关单、不唤醒）。
const TERMINAL_STATUS = ['closed', 'done', 'stale', 'failed', 'cancelled', 'expired', 'superseded'];
/** P0(b)：非终态但"已交付、待收口"——**刻意不入 TERMINAL_STATUS**（否则不再催办、且调用方回执无法再置 closed）。
 *  仅用于"新版本忽略"判据（防 awaiting_close 后同 cid 重复版本重开）。 */
const SETTLED_STATUS = TERMINAL_STATUS.concat(['awaiting_close']);
/** v6.46（2026-09-30）：reply 无 cid 时，取该 from→to 收发的**最近一条 open task** 的 cid。
 *  语义：task.from_id=本 reply 的接收方(targetRole)，task.to_id=本 reply 的发送方(replierRole)。
 *  仅取 replied_at IS NULL 且非终态者；无 → null（防乒乓：无 open task 不唤醒）。
 *  @returns {string|null} cid（无 correlation_id 时回退 task.id） */
function _latestOpenTaskCid(replierRole, targetRole) {
  if (!db) return null;
  try {
    const term = TERMINAL_STATUS.map(() => '?').join(',');
    const r = db.prepare(`SELECT id, correlation_id FROM agent_messages
        WHERE from_id=? AND to_id=? AND type='task' AND replied_at IS NULL
          AND (status IS NULL OR status NOT IN (${term}))
        ORDER BY ts DESC LIMIT 1`)
      .get(String(targetRole), String(replierRole), ...TERMINAL_STATUS);
    if (!r) return null;
    return String(r.correlation_id || r.id);
  } catch { return null; }
}
/** P2b-1 T3：按 cid 精确原子关单——收首个终态 result 时把对应 task 置 closed。
 *  幂等/防并发/防重复唤醒：`replied_at IS NULL` + `status NOT IN(终态)` + `changes==1`。
 *  返回 true=本次确为"首个关单"（调用方置 wake_intent=actionable 唤醒发起方一次）。 */
function closeTaskByCid(cid, opts = {}) {
  if (!db || !cid) return false;
  // 缺陷①（2026-09-29）：result 收口也须校验 rev——低 rev/过期 result 不得关闭新版 task。
  //   opts.rev 为结果自身的版本号（无 rev → null → 保持原行为，不误伤正常单版本 result）。
  const wantRev = (opts.rev != null && Number.isFinite(Number(opts.rev)) && Number(opts.rev) > 0) ? Math.floor(Number(opts.rev)) : null;
  try {
    const notIn = TERMINAL_STATUS.map(() => '?').join(',');
    const revClause = wantRev != null ? ' AND rev=?' : '';
    // P0(b)：先读该 cid 首个未闭环 task 的收口声明与收发方 —— 决定置 closed 还是 awaiting_close。
    const readOpen = (c) => {
      try {
        const params = [String(c), ...TERMINAL_STATUS]; if (wantRev != null) params.push(wantRev);
        return db.prepare(`SELECT from_id, to_id, from_session_id, meta FROM agent_messages
            WHERE correlation_id=? AND type='task' AND replied_at IS NULL AND status NOT IN (${notIn})${revClause}
            ORDER BY ts ASC LIMIT 1`).get(...params) || null;
      } catch { return null; }
    };
    const needsClose = (row) => {
      if (!row || !row.meta) return false;
      try { const mm = JSON.parse(String(row.meta)); return !!(mm && mm.needsCallerClose); } catch { return false; }
    };
    const runClose = (c) => {
      const row = readOpen(c);
      // 有 rev 约束但无匹配的开放 task → 不关单（防旧 rev result 误关新版 task）
      if (wantRev != null && !row) return { changes: 0, row: null, target: null };
      const target = needsClose(row) ? 'awaiting_close' : 'closed';
      const params = [String(c), ...TERMINAL_STATUS]; if (wantRev != null) params.push(wantRev);
      const changes = advance({ where: `correlation_id=? AND type='task' AND replied_at IS NULL AND status NOT IN (${notIn})${revClause}`, params }, needsClose(row) ? 'replyAwait' : 'reply', { now: nowMs() }).changes;
      return { changes, row, target };
    };
    let used = String(cid);
    let r = runClose(used);
    // P2b-12：精确未命中 → 尝试后缀匹配补全（兼容 LLM 复制的末8位短码），命中完整 cid 再关一次。
    if (Number(r.changes) !== 1) {
      try {
        const f = db.prepare(`SELECT correlation_id FROM agent_messages
            WHERE type='task' AND correlation_id LIKE ? ORDER BY ts DESC LIMIT 1`).get('%' + used);
        if (f && f.correlation_id && String(f.correlation_id) !== used) { used = String(f.correlation_id); r = runClose(used); }
      } catch { }
    }
    const closed = Number(r.changes) === 1;
    if (closed) {
      emitMailboxEvent('mailbox-replied', { role: selfRole(), correlationId: used, ts: nowMs() });
      // P0(b)：需收口类任务 → 完成时提醒**发起方**收口（带 cid + actionable，确保唤醒一次；task 已置 awaiting_close 非终态 → 不会被重复关单）。
      if (r.target === 'awaiting_close' && r.row && r.row.from_id) {
        try {
          sendMessage({ from: String(r.row.to_id), to: String(r.row.from_id), type: 'result',
            correlationId: String(used), outcome: 'done',
            content: `任务 ${used} 我方已完成，待你收口（部署/重启）。` });
        } catch { }
        try { emitMailboxEvent('mailbox-awaiting-close', { role: selfRole(), correlationId: used, ts: nowMs() }); } catch { }
      }
    }
    return closed;
  } catch { return false; }
}

// ———————— P2b-4 T1/T2：版本状态查询 + 撤回（cancel）————————
/** 该 cid 是否存在**终态**行（closed/cancelled/superseded/…）——终态单调：终态后同 cid 一律 ignore。 */
function isCidTerminal(cid) {
  if (!db || !cid) return false;
  try {
    const notIn = TERMINAL_STATUS.map(() => '?').join(',');
    const r = db.prepare(`SELECT COUNT(*) c FROM agent_messages
        WHERE correlation_id=? AND status IN (${notIn})`).get(String(cid), ...TERMINAL_STATUS);
    return !!(r && r.c > 0);
  } catch { return false; }
}
/** 该 cid 是否已被撤回（存在 status='cancelled' 的行）——接收方停手检查点用。 */
function isCidCancelled(cid) {
  if (!db || !cid) return false;
  try { const r = db.prepare("SELECT COUNT(*) c FROM agent_messages WHERE correlation_id=? AND status='cancelled'").get(String(cid)); return !!(r && r.c > 0); } catch { return false; }
}
/** cid 最新版本状态（供停手检查点/诊断读）。 */
function cidState(cid) {
  if (!db || !cid) return null;
  try { return db.prepare('SELECT id, type, status, rev FROM agent_messages WHERE correlation_id=? ORDER BY (rev IS NULL), rev DESC LIMIT 1').get(String(cid)) || null; } catch { return null; }
}
/** P2b-4 T2：撤回——把该 cid 全部未闭环行置 cancelled（终态）；返回改动数。comm 亦可直接置 cancelled。 */
function cancelCid(cid) {
  if (!db || !cid) return 0;
  try {
    const notIn = TERMINAL_STATUS.map(() => '?').join(',');
    const _r = advance({ where: `correlation_id=? AND replied_at IS NULL AND status NOT IN (${notIn})`, params: [String(cid), ...TERMINAL_STATUS] }, 'cancel', { now: nowMs() });
    const n = _r.changes;
    if (n > 0) emitMailboxEvent('mailbox-replied', { role: selfRole(), correlationId: String(cid), cancelled: true, ts: nowMs() });
    return Number(n) || 0;
  } catch { return 0; }
}

// ———————— P1：消息内容契约（软校验 + 告警；ADR-0005 §2.1.2）————————
// 只在发送侧 shouldSend（唯一入口）校验；缺必填/超长/非法 outcome/字段类型错 →
//   只降级 content/meta（截断正文、剔除非法字段）+ 告警；**绝不改 type、绝不拒发、绝不静默丢**。
// 告警落 <dataDir>/logs/comm-alerts.log（同 key 60s 去重）。开关 mailboxContractEnabled（默认 true）。
const CONTRACT_MAX = { task: 1500, result: 600, progress: 300, notice: 200 };
const CONTRACT_REQ = {
  task: ['correlationId', 'goal', 'acceptance', 'redlines'],
  result: ['correlationId', 'outcome', 'summary'],
  progress: ['correlationId', 'stage', 'note'],
  notice: ['summary'],
};
const CONTRACT_ARRAY = { task: ['acceptance', 'redlines'], result: [], progress: [], notice: [] };
const VALID_OUTCOMES = ['done', 'partial', 'failed', 'rejected'];
const CONTRACT_META_MAX = 4096;   // meta JSON ≤4KB（§2.1.2 规则6）
// P0(b)：needsCallerClose——派单方声明"完成后需其本人收口（部署/重启）"，完成时置 awaiting_close 并提醒。
const CONTRACT_META_WHITELIST = ['acceptance', 'redlines', 'refs', 'artifacts', 'evidence', 'deadline', 'parentId', 'schema_version', 'needsCallerClose', 'topic'];
// 旧类型 → 契约类型映射（兼容期：reply≈result、ack/notify≈notice）
const CONTRACT_ALIAS = { reply: 'result', ack: 'notice', notify: 'notice' };
function contractType(t) { return CONTRACT_MAX[t] ? t : (CONTRACT_ALIAS[t] || null); }

const _alertLast = new Map();
function alertLogPath() {
  const c = cfg();
  const dd = c.dataDir || path.join(__dirname, '..', 'data');
  return path.join(path.resolve(dd), 'logs', 'comm-alerts.log');
}
/** 写一条内容契约告警（同 key 60s 去重）。仅告警，绝不影响发送。 */
function writeCommAlert(rule, typ, m, detail) {
  try {
    const key = `${typ}|${rule}`;
    const now = Date.now();
    if ((now - (_alertLast.get(key) || 0)) < 60000) return;   // 同 key 60s 去重
    _alertLast.set(key, now);
    const p = alertLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({
      ts: now, iso: new Date(now).toISOString(), level: 'warn', rule, type: typ,
      from: m.from || null, to: m.to || null, id: m.id || null, topic: m.topic || null, detail: String(detail || ''),
    }) + '\n', 'utf8');
  } catch { /* 告警失败绝不影响发送 */ }
}
/** 超长正文全量落共享盘（OUT-2 语义：文本落项目文件总库，共享可读）。返回落盘绝对路径（失败 null）。 */
function overflowFilePath(proj, id) {
  try {
    const c = cfg();
    const root = c.projectFilesRoot || path.join(__dirname, '..', '项目文件');
    const safe = String(proj || 'comm').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'comm';
    const dir = path.join(path.resolve(root), safe, 'mailbox');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${String(id)}.txt`);
  } catch { return null; }
}
/** P1 发送侧内容契约软校验（发送侧唯一入口）：原地归一 m.content/m.meta；违规只告警、不拒发、不改 type。 */
function shouldSend(m, id) {
  if (cfg().mailboxContractEnabled === false) return;
  const rawType = String(m.type || 'task');
  const ct = contractType(rawType);
  if (!ct) return;                                  // 非契约类型（未知）→ 不校验、不告警、原样放行
  // 结构化头：优先取 m.meta（对象），并吸收顶层同名关键字段
  let meta = (m.meta && typeof m.meta === 'object' && !Array.isArray(m.meta)) ? Object.assign({}, m.meta) : {};
  for (const k of ['correlationId', 'goal', 'acceptance', 'redlines', 'outcome', 'summary', 'stage', 'note', 'refs', 'artifacts', 'evidence']) {
    if (m[k] !== undefined && meta[k] === undefined) meta[k] = m[k];
  }
  // ① 字段类型错（acceptance/redlines 须为数组）→ 剔除该字段（降级内容）
  for (const k of CONTRACT_ARRAY[ct]) {
    if (meta[k] !== undefined && !Array.isArray(meta[k])) {
      writeCommAlert('field-type-error', rawType, m, `字段 ${k} 类型错（应数组，实为 ${typeof meta[k]}）→ 已剔除该字段`);
      delete meta[k];
    }
  }
  // ② 非法 outcome（仅 result 类）→ 剔除 outcome（降级内容），保 type
  if (meta.outcome !== undefined && !VALID_OUTCOMES.includes(String(meta.outcome))) {
    writeCommAlert('bad-outcome', rawType, m, `outcome=${meta.outcome} 非枚举(${VALID_OUTCOMES.join('/')}) → 降级剔除，保 type`);
    delete meta.outcome;
  }
  // ③ 缺必填 → 告警（不阻断，仍落库/唤醒；接收方自行补齐）
  for (const k of CONTRACT_REQ[ct]) {
    const v = meta[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
      writeCommAlert('missing-required', rawType, m, `缺必填字段 ${k}（保 type 仍唤醒执行，接收方自行补齐）`);
    }
  }
  // ④ meta 上界（≤4KB）+ 白名单 → 超限按白名单裁剪
  try {
    let mj = JSON.stringify(meta);
    if (mj.length > CONTRACT_META_MAX) {
      for (const k of Object.keys(meta)) { if (!CONTRACT_META_WHITELIST.includes(k)) delete meta[k]; }
      mj = JSON.stringify(meta);
      if (mj.length > CONTRACT_META_MAX) { for (const k of Object.keys(meta)) delete meta[k]; }
      writeCommAlert('meta-overlimit', rawType, m, `meta 超 ${CONTRACT_META_MAX}B → 按白名单裁剪`);
    }
  } catch { meta = {}; }
  // ⑤ 正文超长 → 截断 + 全量落共享盘 + 路径回填（保 type）
  const max = CONTRACT_MAX[ct];
  const body = String(m.content == null ? '' : m.content);
  if (body.length > max) {
    const proj = m.project || m.topic || m.to || m.toSessionId || 'comm';
    const fp = overflowFilePath(proj, id || m.id || newId('m'));
    if (fp) { try { fs.writeFileSync(fp, body, 'utf8'); } catch { } }
    m.content = body.slice(0, max) + (fp ? `\n…[正文超长 ${body.length}字，已截断；全文见 ${fp}]` : `\n…[正文超长 ${body.length}字，已截断]`);
    writeCommAlert('overlength', rawType, m, `正文 ${body.length}字 > ${max} → 截断${fp ? '，全文落 ' + fp : ''}`);
  }
  m.meta = meta;   // 归一结果回写（P2a 落 meta 列；P1 仅内存归一）
}

/** P1：信箱全量流水（含已闭环）——纯读无副作用（绝不调 markRead）。走 idx_msg_conv(from_id,to_id,ts)。 */
function listFlow(opts = {}) {
  if (!db) return [];
  const lim = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
  const off = Math.max(0, Number(opts.offset) || 0);
  const since = Number(opts.since) || 0;
  const clauses = []; const params = [];
  if (opts.from) { clauses.push('from_id=?'); params.push(String(opts.from)); }
  if (opts.to) { clauses.push('to_id=?'); params.push(String(opts.to)); }
  if (since > 0) { clauses.push('ts>=?'); params.push(since); }
  const where = clauses.length ? ('WHERE ' + clauses.join(' AND ')) : '';
  params.push(lim, off);
  try {
    return db.prepare(`SELECT * FROM agent_messages ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...params);
  } catch { return []; }
}

function sendMessage(m) {
  if (!db) throw new Error('mailbox 未初始化');
  const mtype = String(m.type || 'task');
  // P0①（ADR-0005 v9/v10 §2.5 无环硬不变式#1）：发送侧拒绝 **task 自环**（from===to 且 type=task）。
  //   保留 notifySession 合法 self-notify 白名单（其 type=notify，不受此拦截）。
  //   "缩窄"= 仅拦 task；其余类型（notify/reply/ack/result）的自环一律放行。
  if (mtype === 'task' && String(m.from) === String(m.to)) {
    try { console.warn(`[mailbox] 拒发 task 自环：from=${m.from} to=${m.to} topic=${m.topic || ''}`); } catch { }
    return null;
  }
  const id = m.id || newId('m');
  // P2b-1 T2：cid 全链路——task 缺省生成 cid（=本消息 id）并落库；result 取传入 cid 指回原 task。
  const cidIn = m.correlationId || m.correlation_id || (m.meta && m.meta.correlationId) || null;
  let correlationId = null;
  if (mtype === 'task') correlationId = String(cidIn || id);
  else if (mtype === 'result') {
    correlationId = cidIn ? String(cidIn) : null;
    // P2b-6→P2b-11→P2b-12：接收方回 result 时未必持有完整 cid，且 runtime 注入的短 cid(末8位)会被 LLM 直接复制。
    //   统一处理：①无显式 cid → 从正文正则提取；②把（可能为短码的）cid 经 resolveFullCid 精确→后缀匹配补全为完整 cid；
    //   ③补全失败（查无对应 task）→ 置 null 降级 P1a（单条才关，防误关）；④仍无 cid 且 open task 恰 1 条 → 补它；≥2 条歧义 → 不补。
    if (!correlationId) {
      try {
        const s = String(m.content || '');
        const mm = s.match(/\b(?:cid|correlationId)\s*[=:]\s*([A-Za-z0-9_-]+)/i);
        if (mm && mm[1]) correlationId = String(mm[1]);
      } catch { }
    }
    if (correlationId) correlationId = resolveFullCid(correlationId, m.from, m.to);   // 短码→完整；查无→null（降级 P1a）
    if (!correlationId) {
      try {
        const rows = db.prepare(`SELECT correlation_id FROM agent_messages
            WHERE from_id=? AND to_id=? AND type='task' AND replied_at IS NULL AND correlation_id IS NOT NULL
            ORDER BY ts DESC`).all(String(m.to), String(m.from));
        if (rows.length === 1) correlationId = String(rows[0].correlation_id);
        // rows.length===0：无可补；≥2：歧义保守，不补（防误关，交由 P1a 亦保守处理）
      } catch { }
    }
  }
  else correlationId = cidIn ? String(cidIn) : null;
  // —— P2b-4 T1/T3：版本(rev) + 幂等键(from,to,cid,type,rev) + 终态单调 ——
  //   task 缺省 rev=1；同 (from,to,cid,type,rev) 完全重复 → 幂等（不新增行、不唤醒）；
  //   新 rev > 既有 max(rev) 且无终态 → 生效并把旧 rev 置 superseded；否则（旧 rev / 终态后）→ 本行 superseded 不唤醒。
  let rev = null;
  { const _r = Number(m.rev); if (Number.isFinite(_r) && _r > 0) rev = Math.floor(_r); }
  if (mtype === 'task' && rev == null) rev = 1;
  let rowStatus = 'pending', supersedes = null, isRevision = false, versionIgnored = false;
  if (mtype === 'task' && correlationId) {
    try {
      const peers = db.prepare(`SELECT id, rev, status FROM agent_messages
          WHERE from_id=? AND to_id=? AND correlation_id=? AND type='task'
          ORDER BY (rev IS NULL), rev ASC`).all(String(m.from), String(m.to), String(correlationId));
      if (peers.some((p) => Number(p.rev) === rev)) return peers.find((p) => Number(p.rev) === rev).id;   // 幂等：完全重复 → 返回既有 id
      if (peers.length) {
        const anyTerminal = peers.some((p) => SETTLED_STATUS.includes(String(p.status)));
        const maxRev = peers.reduce((mx, p) => Math.max(mx, Number(p.rev) || 0), 0);
        if (anyTerminal || maxRev >= rev) { rowStatus = 'superseded'; versionIgnored = true; }   // 终态后 / 旧版本 → 忽略
        else {
          isRevision = true;
          const old = peers.filter((p) => !TERMINAL_STATUS.includes(String(p.status))).map((p) => p.id);
          if (old.length) {
            // P1：收口到 advance（'supersede'）
            for (const oid of old) { try { advance(String(oid), 'supersede', {}); } catch { } }
            supersedes = old[old.length - 1];
          }
        }
      }
    } catch { }
  }
  // 缺陷①（2026-09-29）：result 收口前校验 rev——存在更高版本的 task → 本 result 过期：不关单、不唤醒（与 task 旧版本语义一致）。
  if (mtype === 'result' && correlationId && rev != null) {
    try {
      const mx = Number((db.prepare(`SELECT MAX(rev) mx FROM agent_messages WHERE correlation_id=? AND type='task'`).get(String(correlationId)) || {}).mx) || 0;
      if (mx > rev) { versionIgnored = true; rowStatus = 'superseded'; }   // 过期 → 自身置 superseded（终态），与 task 旧版本语义一致
    } catch { }
  }
  // P2b-1 T3 → P2b-13（解耦唤醒与关单）：唤醒判据改为"该 cid 的**首个 result**"，与 task 是否已被抢先关单无关。
  //   原缺陷：唤醒绑在 closeTaskByCid 成功(需 replied_at IS NULL)上 → 任何抢先关单(reconcile/P1a/turn-close)都吞掉唤醒
  //   （真机实证：cid=m-muae1zr1-c83b6ccd 的 task 06:30:27 被 reconcile 提前关单 → 迟到 result changes=0 → 不唤醒）。
  //   新语义：首个 result 必唤醒一次；同 cid 后续 result 不唤醒（防放大，M2 语义不变）。关单仍尝试（幂等）。
  //   显式传入的 wakeIntent（如 P0② task-state done）优先，不覆盖。自环不参与（from===to 跳过）。
  // v6.31（2026-09-29·彻底版）：唤醒判定单函数收口 —— 发送侧唯一决策处 = wakeDecision()。
  let wakeIntent = null;
  try {
    const _wd = wakeDecision({ type: mtype, from: m.from, to: m.to, content: m.content,
      correlationId, wakeIntent: m.wakeIntent || null, sysNotice: !!m.sysNotice });
    if (_wd && _wd.wake) wakeIntent = 'actionable';
    // v6.46：reply 无 cid 自动关联到 open task → 把补出的 cid 落回本行（供 closeTaskByCid + 持久化，幂等靠 UNIQUE 索引）。
    if (_wd && _wd.cid && !correlationId) { correlationId = String(_wd.cid); }
  } catch { }
  // 关单仍尝试（幂等；与唤醒判定解耦）——result 及"开关为新的"带 cid reply。
  try {
    const _replyViaCid = mtype === 'reply' && cfg().mailboxReplyCidWake !== false;
    if (correlationId && (mtype === 'result' || _replyViaCid)) closeTaskByCid(correlationId, { rev: (mtype === 'result' ? rev : null) });
  } catch { }
  // v6.31：原 P2b-14/P2b-15/P1a 三处启发式唤醒块已退役（统一由 wakeDecision() 决策；_resultDedupeMs 保留供其复用）。
  if (versionIgnored) wakeIntent = null;   // superseded（重放/终态后）不唤醒
  // P1：内容契约软校验（ADR-0005 §2.1.2，发送侧唯一入口）——降级保 type + 告警，绝不拒发/丢消息。
  try { shouldSend(m, id); } catch (e) { try { console.warn('[mailbox] 内容契约校验异常：' + e.message); } catch { } }
  // GAP-3（P2b-6 批）：结构化头/deadline/父任务落列——此前列已迁移但 INSERT 从未写入 → 全丢。
  //   值取 shouldSend 归一后的 m.meta（含白名单字段）+ 顶层或 meta 的 deadline/parentId。
  let _metaJson = null;
  try { if (m.meta && typeof m.meta === 'object' && !Array.isArray(m.meta) && Object.keys(m.meta).length) _metaJson = JSON.stringify(m.meta); } catch { }
  const _dlRaw = (m.deadline != null) ? m.deadline : (m.meta && m.meta.deadline);
  const _deadline = (_dlRaw != null && _dlRaw !== '' && Number.isFinite(Number(_dlRaw))) ? Number(_dlRaw) : null;
  const _pidRaw = (m.parentId != null) ? m.parentId : (m.meta && m.meta.parentId);
  const _parentId = (_pidRaw != null && _pidRaw !== '') ? String(_pidRaw) : null;
  const _sysNotice = (m.sysNotice ? 1 : 0);   // v6.30：系统通知标记（不占"首个 result"唤醒名额）
  // P2（R3）：wake_intent 拆列——notify_target（发送侧唤醒意图）+ is_pending（接收侧是否待办）。
  //   notify_target 与 wake_intent 同步（迁移期兼容）；is_pending 由 (type, wakeIntent) 派生（接收侧语义）。
  const notifyTarget = (wakeIntent === 'actionable') ? 'actionable' : null;
  const isPending = pendingByMessage(mtype, wakeIntent) ? 1 : 0;
  // P1 遗留3：INSERT 时同步写 state（治"新行 state=NULL → 与 status 不同步"）。rowStatus=pending→inbox；superseded→closed。
  const initState = statusToState(rowStatus);
  db.prepare(`INSERT OR IGNORE INTO agent_messages
      (id,from_id,to_id,from_session_id,to_session_id,topic,type,content,ts,priority,read_at,replied_at,status,attempts,delivered,wake_intent,correlation_id,rev,supersedes,meta,deadline,parent_id,sys_notice,notify_target,is_pending,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, String(m.from), String(m.to), m.fromSessionId || null, m.toSessionId || null,
      m.topic || null, mtype, String(m.content), nowMs(), m.priority || 'normal',
      null, null, rowStatus, 0, 0, wakeIntent, correlationId, rev, supersedes,
      _metaJson, _deadline, _parentId, _sysNotice, notifyTarget, isPending, initState);
  try { _sendMeta.set(id, { id, cid: correlationId, rev, isRevision, versionIgnored, rowStatus, wakeIntent, from: String(m.from), to: String(m.to) }); if (_sendMeta.size > 500) _sendMeta.delete(_sendMeta.keys().next().value); } catch { }
  return id;
}

// P2b-15（2026-09-29）：无 cid result 的唤醒去重窗口（毫秒）。默认 2 小时；可被 cfg.mailboxResultDedupeMs 覆盖。
function _resultDedupeMs() {
  try { const v = Number(cfg().mailboxResultDedupeMs); return (Number.isFinite(v) && v > 0) ? v : 2 * 60 * 60 * 1000; } catch { return 2 * 60 * 60 * 1000; }
}

/** v6.31（2026-09-29·彻底版）：系统通知唤醒独立限频窗口（ms）。默认 10 分钟；可被 cfg.mailboxSysNoticeDedupeMs 覆盖。 */
function _sysNoticeDedupeMs() {
  try { const v = Number(cfg().mailboxSysNoticeDedupeMs); return (Number.isFinite(v) && v > 0) ? v : 10 * 60 * 1000; } catch { return 10 * 60 * 1000; }
}
/** 幂等位：某 cid 的"真终态回执"是否已唤醒过（终态单调，已唤醒=不再唤醒）。 */
function _taskNotified(cid) {
  if (!db || !cid) return false;
  try { const r = db.prepare('SELECT notified_at FROM task_wake_log WHERE cid=?').get(String(cid)); return !!(r && r.notified_at); } catch { return false; }
}
/** 幂等位：原子标记"该 cid 已唤醒真终态回执"。@returns true=本次为首次（调用方应唤醒）。 */
function _markTaskNotified(cid) {
  if (!db || !cid) return true;
  try {
    const n = db.prepare('INSERT OR IGNORE INTO task_wake_log(cid, notified_at) VALUES(?,?)').run(String(cid), nowMs()).changes;
    if (Number(n) === 1) return true;
    // 已存在行但 notified_at 为空（此前仅系统通知过）→ 补记并放行一次。
    const r = db.prepare('SELECT notified_at FROM task_wake_log WHERE cid=?').get(String(cid));
    if (r && !r.notified_at) { db.prepare('UPDATE task_wake_log SET notified_at=? WHERE cid=?').run(nowMs(), String(cid)); return true; }
    return false;
  } catch { return true; }
}
/** v6.47：接收侧"真起回合并消费该 cid"时记位（notified_at=决策 / woke_at=真处理，拆两位）。幂等 UPSERT，绝不抛。 */
function markCidWoke(cid) {
  if (!db || !cid) return;
  try {
    db.prepare('INSERT INTO task_wake_log(cid, woke_at) VALUES(?,?) ON CONFLICT(cid) DO UPDATE SET woke_at=excluded.woke_at').run(String(cid), nowMs());
  } catch { }
}
/** v6.47：该 cid 是否已"真起回合消费"过。 */
function cidWoke(cid) {
  if (!db || !cid) return false;
  try { const r = db.prepare('SELECT woke_at FROM task_wake_log WHERE cid=?').get(String(cid)); return !!(r && r.woke_at); } catch { return false; }
}
/** 系统通知独立限频：窗口内同 cid 只唤醒一次（不占 notified_at 终态位）。@returns true=应唤醒。 */
function _sysNoticeGate(cid) {
  if (!db || !cid) return true;
  try {
    const r = db.prepare('SELECT sys_notified_at FROM task_wake_log WHERE cid=?').get(String(cid));
    if (r && r.sys_notified_at && (Date.now() - Number(r.sys_notified_at)) < _sysNoticeDedupeMs()) return false;
    db.prepare('INSERT INTO task_wake_log(cid, sys_notified_at) VALUES(?,?) ON CONFLICT(cid) DO UPDATE SET sys_notified_at=excluded.sys_notified_at').run(String(cid), Date.now());
    return true;
  } catch { return true; }
}

/**
 * v6.31（2026-09-29·彻底版）：**唤醒/回执单决策点**（发送侧唯一决策处）。
 *   原则：按「事件语义」判，不按「谁先到(首个)」判；独立幂等位；与关单态解耦。
 *   输入 m：{ type, from, to, content, correlationId, wakeIntent, sysNotice }
 *   @returns {{wake:boolean, reason:string}}
 *   规则：
 *     - 自环/非法 → 不唤醒；
 *     - task/ack/notify：唤醒由消费侧按类型判定（isActionableType），此处仅透传显式 wakeIntent；
 *     - 显式 wakeIntent='actionable' → 优先（如 task-state done），不占终态位；
 *     - system_notice（sysNotice）→ 独立限频唤醒，**不占**终态通知位；
 *     - terminal_receipt（result/failed）→ 该 cid 未通知过则唤醒一次（原子记位）；同 cid 后续不唤醒（防放大）；
 *     - reply → 按现策略（带 cid 精确 / P1a 启发式）。
 *   回滚开关：mailboxReplyCidWake（reply 精确）；mailboxSysNoticeNoSlot（系统通知不占位，本函数天然不占）。
 */
function wakeDecision(m) {
  try {
    const from = String((m && m.from) || ''), to = String((m && m.to) || '');
    if (!from || !to || from === to) return { wake: false, reason: 'self-or-invalid' };
    const t = String((m && m.type) || 'task');
    if (m && m.wakeIntent === 'actionable') return { wake: true, reason: 'explicit' };
    if (t === 'task' || t === 'ack' || t === 'notify') return { wake: false, reason: 'type-default' };
    if (m && m.sysNotice) {
      const cid = m.correlationId ? String(m.correlationId) : null;
      const ok = _sysNoticeGate(cid);
      return { wake: ok, reason: ok ? 'system-notice' : 'system-notice-rate-limited' };
    }
    if (t === 'result') {
      const cid = m.correlationId ? String(m.correlationId) : null;
      if (cid) return { wake: _markTaskNotified(cid), reason: 'terminal-receipt' };
      // 无 cid：内容指纹去重（窗口内同 (from,to,fp) 只唤醒首个）
      const fp = String(m.content == null ? '' : m.content).replace(/\s+/g, '').slice(0, 80);
      if (fp && db) {
        try {
          const winMs = _resultDedupeMs();
          const prior = db.prepare("SELECT 1 FROM agent_messages WHERE type='result' AND (correlation_id IS NULL OR correlation_id='') AND from_id=? AND to_id=? AND substr(replace(replace(content,char(10),''),' ',''),1,?)=? AND ts>=? LIMIT 1")
            .get(from, to, fp.length, fp, Date.now() - winMs);
          if (prior) return { wake: false, reason: 'result-fp-dup' };
        } catch { }
      }
      return { wake: true, reason: 'terminal-receipt-nocid' };
    }
    if (t === 'reply') {
      const replyCidWake = cfg().mailboxReplyCidWake !== false;
      const cid = m.correlationId ? String(m.correlationId) : null;
      if (replyCidWake && cid) return { wake: _markTaskNotified(cid), reason: 'reply-cid' };
      // v6.46（2026-09-30）：reply 无 cid → **自动关联最近一条 open task**（同 from/to、replied_at IS NULL、非终态），
      //   补 cid 并复用「带 cid 唤醒路径」(_markTaskNotified 记 task_wake_log，幂等)。
      //   治本：雷影回执常忘带 cid → 原落 'reply-heuristic'(需恰 1 条 open task，歧义保守) 或静默不唤醒。
      //   防乒乓：仅当存在 open task 才唤醒；无 open task → 维持不唤醒（纯 ack/闲聊不触发）。
      const autoCid = replyCidWake ? _latestOpenTaskCid(from, to) : null;
      if (autoCid) return { wake: _markTaskNotified(autoCid), reason: 'reply-auto-cid', cid: autoCid };
      return { wake: consumeInboundTaskForReply(from, to), reason: 'reply-heuristic' };
    }
    return { wake: false, reason: 'no-wake-type' };
  } catch { return { wake: false, reason: 'error' }; }
}

/** 取该 role 未读消息（read_at IS NULL），按 ts 升序。 */
function fetchUnread(role, limit = 50) {
  if (!db || !role) return [];
  // v6阶段2：urgent/high 置顶（同 ts 之前），其余按 ts 升序（原序不变）
  return db.prepare(`SELECT * FROM agent_messages WHERE to_id=? AND read_at IS NULL
      ORDER BY CASE WHEN priority IN ('urgent','high') THEN 0 ELSE 1 END, ts ASC LIMIT ?`)
    .all(String(role), Number(limit) || 50);
}

/** 取该 role 未读条数（read_at IS NULL 且"需处理"类型）——供 summary 的"未读"口径使用。
 *  ★2026-09-24 修：静默类（reply/ack/notify = NON_ACTION_TYPES）**一律不计入未读**。
 *  原口径 `type NOT IN (...) OR ts >= staleCut` 会把 30min 内的新鲜回执也算进来 → 收件方无回合永不读
 *  → 顶栏角标挂 1 消不掉。现改为与"是否需处理"完全一致：静默类恒排除（无需依赖 markAgedNonActionRead 补标）。
 *  清单选择：复用已有常量 NON_ACTION_TYPES（= reply/ack/notify，与 fetchUnreadForSession 排除口径同源）；
 *  不用 cfg.mailboxSilentTypes（默认仅 ['reply']，语义是"抑制唤醒"，与"是否需处理"不等价）。 */
function countUnread(role) {
  if (!db || !role) return 0;
  try {
    const nx = nonActionSql('type');   // v6.50-补：判据单源——静默清单派生自 classify()，禁 SQL 硬编码
    const term = TERMINAL_STATUS.map(() => '?').join(',');
    // v6.36：已终态（cancelled/closed/expired/failed/superseded…）一律不计入未读——终态即"无需再看"。
    //   兼作存量兜底：终态为吸收态、advance 不能再收口，故对"存量终态但 read_at 仍空"的行在此排除。
    // v6.50（定案 B）：读判据从**权威 state** 派生（read_at/status 为镜像）；终态/已消费天然排除。
    return db.prepare(`SELECT COUNT(*) AS c FROM agent_messages
        WHERE to_id=? AND COALESCE(state,'inbox')='inbox' AND injected_at IS NULL AND ${nx.sql}`)
      .get(String(role), ...nx.params).c;
  } catch { return 0; }
}

/** v6.47（2026-09-30）：扫"有 open 入站但从未真起回合处理"的**动作类**消息（治主我 busy 时回执唤醒丢失）。
 *  判据：to_id=role、read_at IS NULL（未读=未被回合消费）、injected_at IS NULL、is_pending=1（动作类）、
 *  非终态、会话匹配（to_session_id=sessionId 或 NULL）、ts <= now-minAgeMs（给正常唤醒留时间），
 *  且**带 cid 者其 task_wake_log.woke_at 为空**（决策过但从未真起回合=窗口丢失）。
 *  @returns {Array} 命中行（升序） */
function listNotWokeInbound(role, sessionId, opts = {}) {
  if (!db || !role) return [];
  const minAgeMs = Number.isFinite(Number(opts.minAgeMs)) ? Math.max(0, Number(opts.minAgeMs)) : 90000;
  const lim = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  try {
    const term = TERMINAL_STATUS.map(() => '?').join(',');
    // v6.48（P2 判据单函数化）：**不再在 SQL 里复写「是否待办」**——统一用 pendingByMessage()（写侧同源），
    //   杜绝 SQL↔JS 两处各写漂移。SQL 先做粗过滤（放宽 LIMIT 4×），再由 JS 用同一判据精筛。
    const rows = db.prepare(`SELECT * FROM agent_messages
        WHERE to_id=? AND COALESCE(state,'inbox')='inbox' AND injected_at IS NULL AND ts <= ?
          AND (to_session_id=? OR to_session_id IS NULL)
          AND (status IS NULL OR status NOT IN (${term}))
          AND (correlation_id IS NULL OR correlation_id='' OR NOT EXISTS (
                SELECT 1 FROM task_wake_log w WHERE w.cid=agent_messages.correlation_id AND w.woke_at IS NOT NULL))
        ORDER BY ts ASC LIMIT ?`)
      .all(String(role), Date.now() - minAgeMs, String(sessionId || ''), ...TERMINAL_STATUS, Math.min(800, lim * 4));
    // v6.53-补（tester 揪出）：sweep 兜底路径同样**认领** NULL 归属行——否则 NULL 行会被"当前会话"
    //   的 sweep 命中（且 runtime 对**所有空闲会话**逐个扫）→ 多会话重复/错位唤醒。与 fetchUnread/
    //   listPending 同策略：吸纳即认领（幂等，只写 NULL 行）。
    _claimNullSession(role, sessionId, rows, opts);
    return rows.filter((r) => classify(r).pending).slice(0, lim);
  } catch { return []; }
}
/** v6.47：是否**存在**未起回合处理的动作类入站（供 sweep 快速判定，LIMIT 1）。 */
function hasNotWokeInbound(role, sessionId, opts = {}) {
  return listNotWokeInbound(role, sessionId, Object.assign({ limit: 1 }, opts || {})).length > 0;
}

/** v6.53（2026-09-30）：知情类回执「空闲兜底唤醒」候选扫描（纯读，无副作用）。
 *  命中：来自其他智能体、type∈{reply,ack,notify,result}（不可唤醒知情类，NON_WAKEABLE_TYPES_SQL）、**未读**(read_at IS NULL)、非终态、
 *        归属本会话或未归属(to_session_id=? OR IS NULL)、到达已超 minAgeMs、且 silent_wake_log 未记过（同批只提醒一次）。
 *  治：reply/ack/notify（无 cid）既不唤醒也不进未读续跑 → 主我空闲时永久漏收（实测 m-muo8el3o）。
 *  @returns {Array} 命中的行（ts 升序），无命中返回 []。绝不抛。 */
function listStaleSilentInbound(role, sessionId, opts = {}) {
  if (!db || !role || !sessionId) return [];
  try {
    const minAgeMs = Number.isFinite(Number(opts.minAgeMs)) ? Math.max(0, Number(opts.minAgeMs)) : 45000;
    const lim = Number(opts.limit) > 0 ? Number(opts.limit) : 10;
    const cutoff = nowMs() - minAgeMs;
    const term = TERMINAL_STATUS.map(() => '?').join(',');
    // v6.53b：类型集 = 所有不可唤醒知情类（{reply,ack,notify,result}，单一权威 NON_WAKEABLE_TYPES_SQL）；
    //   并排除显式 actionable 行（那些由动作类 sweepLostInboundWakes 兜底，防重复）。
    const tp = NON_WAKEABLE_TYPES_SQL.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM agent_messages
        WHERE to_id=? AND (to_session_id=? OR to_session_id IS NULL)
          AND read_at IS NULL AND status NOT IN (${term})
          AND type IN (${tp})
          AND COALESCE(notify_target,'')<>'actionable' AND COALESCE(wake_intent,'')<>'actionable'
          AND ts <= ? AND from_id <> ?
          AND id NOT IN (SELECT msg_id FROM silent_wake_log)
        ORDER BY ts ASC LIMIT ?`)
      .all(String(role), String(sessionId), ...TERMINAL_STATUS, ...NON_WAKEABLE_TYPES_SQL, cutoff, String(role), lim);
  } catch { return []; }
}

/** v6.53：标记这批知情类回执已兜底提醒（幂等 INSERT OR IGNORE）。@returns 新标记条数。 */
function markStaleSilentNotified(ids) {
  if (!db) return 0;
  const arr = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x)).filter(Boolean);
  if (!arr.length) return 0;
  let n = 0;
  try {
    const st = db.prepare('INSERT OR IGNORE INTO silent_wake_log(msg_id, notified_at) VALUES(?,?)');
    const t = nowMs();
    for (const id of arr) { try { n += Number(st.run(id, t).changes) || 0; } catch { } }
  } catch { }
  return n;
}


/** 取"某主会话"的未读消息：受信于本条会话的（to_session_id=该会话）或未指定会话的（NULL）。
 *  v6.1 追加修订#2（未读注入与"续跑"同口径收窄，防陈年回执反复上屏）：
 *   ① task 类（需处理的活）不设时效：即便会话忙久了，新派活也不会漏注入（避免误杀真待办）；
 *   ② reply/ack/notify 类（只需知晓、无需回复）仅注入 STALE_TASK_MS(30min) 内的新鲜消息：
 *      超过阈值的陈年回执不再注入（历史回执仍可用 agent_inbox 主动查看）。 */
/** v6.51（多会话隔离·接收侧认领）：把本会话**吸纳**的 `to_session_id IS NULL` 行立即回写归属=当前会话。
 *  背景：`OR to_session_id IS NULL` 让无归属行对**所有会话**可见 → 被活跃会话反复吸走（串台）。
 *  语义：合法未知归属第一次仍可见；被某会话吸走一次后即认领，不再被其他会话重复吸走。
 *  幂等：`WHERE ... AND to_session_id IS NULL` 只写 NULL 行，重复调用 no-op，绝不覆盖已有归属。
 *  opts.claim === false → 纯读探测（诊断/树视图）不认领，避免只读调用产生副作用。 */
function _claimNullSession(role, sessionId, rows, opts = {}) {
  const out = rows || [];
  if (!db || !role || !sessionId || (opts && opts.claim === false)) return out;
  let stmt = null;
  try { stmt = db.prepare('UPDATE agent_messages SET to_session_id=? WHERE id=? AND to_id=? AND to_session_id IS NULL'); } catch { return out; }
  for (const r of out) {
    if (!r || (r.to_session_id != null && r.to_session_id !== '')) continue;
    try {
      const res = stmt.run(String(sessionId), String(r.id), String(role));
      if (res && res.changes > 0) r.to_session_id = String(sessionId);   // 回写内存行，保证本次返回归属与库一致
    } catch { }
  }
  return out;
}

function fetchUnreadForSession(role, sessionId, limit = 50, opts = {}) {
  if (!db || !role) return [];
  const staleCut = Date.now() - staleTaskMs();
  // v6.50（定案 B/D）：未读判据从**权威 state** 派生（未消费='inbox'）；injected_at 仅作镜像护栏（防存量不一致行漏判）。
  //   非动作类仍限新鲜窗口，
  //   但超窗**不再永久残留**——由 sweepSilentRead() 静默收口（自动已读，不驱动回合）。
  const nx = nonActionSql('type');   // v6.50-补：判据单源——静默清单派生自 classify()，禁 SQL 硬编码
  const rows = db.prepare(`SELECT * FROM agent_messages
      WHERE to_id=? AND COALESCE(state,'inbox')='inbox' AND injected_at IS NULL AND (to_session_id=? OR to_session_id IS NULL)
        AND (${nx.sql} OR ts >= ?)
      ORDER BY CASE WHEN priority IN ('urgent','high') THEN 0 ELSE 1 END, ts ASC LIMIT ?`)
    .all(String(role), sessionId || '', ...nx.params, staleCut, Number(limit) || 50);
  return _claimNullSession(role, sessionId, _dedupeCidRev(rows), opts);
}

/** P2b-4 T1（ADR §2.4.2）：同 cid 只取 max(rev)——旧版本（rev1）不再注入；无 cid 的行原样保留。
 *  抽公共函数：fetchUnreadForSession / fetchInboundByIds 共用同口径（防两处各判漂移）。 */
function _dedupeCidRev(rows) {
  try {
    const seen = new Map(); const out = [];
    for (const m of rows) {
      const cid = m.correlation_id ? String(m.correlation_id) : null;
      if (!cid) { out.push(m); continue; }
      const r = Number(m.rev) || 0;
      const prev = seen.get(cid);
      if (!prev) { seen.set(cid, { rev: r, idx: out.length }); out.push(m); }
      else if (r > prev.rev) { out[prev.idx] = m; prev.rev = r; }   // 更高版本替换旧版本
      // r <= prev.rev → 丢弃（旧版本/重复）
    }
    return out;
  } catch { return rows; }
}

/** 会诊定案 A（2026-09-30）：按 id 批量取本会话入站消息——供"补唤醒"精确注入。
 *  与 fetchUnreadForSession 的**关键差异：不按 read_at/injected_at 过滤**（消息可能已被消费，
 *  但正文仍需进本回合上下文，治"补唤醒空回合"）；**限定 to_session_id=? + 未终态**
 *  （防把别会话消费过的行拉回）。同 cid 只取 max(rev)，与 fetchUnreadForSession 同口径。
 *  @returns {Array} 命中的消息行（按 priority/ts 排序），无命中返回 [] */
function fetchInboundByIds(role, sessionId, msgIds) {
  if (!db || !role) return [];
  const ids = (Array.isArray(msgIds) ? msgIds : []).map((x) => String(x)).filter(Boolean);
  if (!ids.length) return [];
  try {
    const ph = ids.map(() => '?').join(',');
    const term = TERMINAL_STATUS.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM agent_messages
        WHERE to_id=? AND id IN (${ph}) AND to_session_id=? AND status NOT IN (${term})
        ORDER BY CASE WHEN priority IN ('urgent','high') THEN 0 ELSE 1 END, ts ASC`)
      .all(String(role), ...ids, sessionId || '', ...TERMINAL_STATUS);
    return _dedupeCidRev(rows);
  } catch { return []; }
}

// ———————— P1 状态机：消息生命周期单一转换入口（治 R1/R2/R5） ————————
// state: inbox → injected → consumed → closed（终态集合 closed/expired/failed）。单调不可逆（reset 显式例外）。
const STATE_TERMINAL = ['closed', 'expired', 'failed'];
const STATE_RANK = { inbox: 0, injected: 1, consumed: 2, closed: 3, expired: 3, failed: 3 };
/** v6.50-补：进入「已注入/已消费」即视为已展示 → read_at 必须同步置位（写侧不变量，read_at 为 state 派生镜像）。 */
const READ_MIRROR_STATES = new Set(['injected', 'consumed']);
/** 旧 status → 新 state（读侧兼容 / 存量回填）。 */
function statusToState(st) {
  const s = String(st || '');
  if (s === 'pending') return 'inbox';
  if (s === 'processing') return 'injected';
  if (s === 'done' || s === 'closed' || s === 'cancelled' || s === 'superseded' || s === 'awaiting_close') return 'closed';
  if (s === 'stale' || s === 'expired') return 'expired';
  if (s === 'failed') return 'failed';
  return 'inbox';
}
function _stateMachineOn() { try { return cfg().mailboxStateMachine === true; } catch { return false; } }
/** v6.50（定案 A·判据单源）：入站消息**唯一分类函数**（QR-6 治本）。
 *  "是否注入 injectable / 是否唤醒 wakeable / 是否待办 pending / 是否可静默标读 autoRead"**只在此定义一处**；
 *  fetchUnreadForSession / countUnread / listPendingForSession / pendingByMessage / listNotWokeInbound /
 *  runtime.isActionableType 全部委派本函数，杜绝散点各判漂移。
 *  D/E：reply/ack/notify **默认不唤醒、非待办、可静默标读**；result 亦默认知情类；
 *      仅当发送侧**显式** wake_intent/notify_target='actionable'（"首个关单"语义，v6.48/tester U1/R11 红线）才升级为动作类。
 *  injectable：非动作类仅注入"新鲜窗口"内（起始未读注入用）；超窗**不永久排除**——交由 autoRead 静默收口（定案 C/D）。
 * @param {object|string} row 行对象或 type 字符串
 * @param {{cfg?:object}} [opts]
 * @returns {{type:string,actionable:boolean,wakeable:boolean,pending:boolean,waitable:boolean,injectable:boolean,autoRead:boolean}}
 */
function classify(row, opts = {}) {
  const r = (row && typeof row === 'object') ? row : { type: row };
  const t = String(r.type || 'task');
  const explicit = notifyTargetOf(r) === 'actionable';           // 发送侧显式唤醒意图
  const nonWake = NON_WAKE_TYPES.includes(t);                     // 默认知情类（reply/ack/notify/result）
  const actionable = explicit || !nonWake;                        // 动作类（task 等）或显式升级
  const ts = Number(r.ts);
  const fresh = !Number.isFinite(ts) || (Date.now() - ts) < staleTaskMs();
  const silent = NON_ACTION_TYPES.includes(t);
  return {
    type: t,
    actionable,
    wakeable: actionable,
    pending: actionable,
    // v6.50-补：静默类（reply/ack/notify）**即便显式 actionable 也不作"待办"**（仅唤醒/上屏，不可被续跑重放）。
    //   与 listPendingForSession / v6.34 注释语义一致，收口"带 actionable 的回执被 [信箱续跑] 二次注入"（真机 m-mun19pz7）。
    waitable: actionable && !silent,
    injectable: !silent || explicit || fresh,
    autoRead: silent && !actionable,                              // 可静默标读（read 语义="已展示"）
  };
}
/** P2（R3）：接收侧"是否待办"判据 —— v6.50 起委派唯一分类函数 classify()。 */
function pendingByMessage(type, wakeIntent) {
  return classify({ type, wake_intent: wakeIntent }).pending;
}
/** P2：发送侧"唤醒意图"单一判据（notify_target 优先，回退兼容列 wake_intent）。 */
function notifyTargetOf(row) {
  if (!row) return null;
  return row.notify_target != null ? String(row.notify_target) : (row.wake_intent === 'actionable' ? 'actionable' : null);
}
function _isTerminalState(st) { return STATE_TERMINAL.includes(String(st)); }
/** 读一条消息的权威状态（state 优先，回退旧 status 映射）。 */
function stateOf(id) {
  if (!db || !id) return null;
  try { const r = db.prepare('SELECT state, status FROM agent_messages WHERE id=?').get(String(id)); if (!r) return null; return r.state ? String(r.state) : statusToState(r.status); } catch { return null; }
}

/** P1：**唯一**状态转换入口。所有消费/唤醒路径只发事件，不再各自 UPDATE status。
 *  target: id(string) | {ids:[...]} | {where:'SQL片段', params:[...]}
 *  event:  EVENT_STATE 的键
 *  opts:   { now, onlyIf:'额外 WHERE 片段(可含?)', params:[...placeholders for onlyIf], statusOverride }
 *  返回 {changes, blocked, ids}。灰度：state 与旧 status/时间戳**双写**（mailboxStateMachine 仅切换读侧权威）。
 */
const EVENT_STATE = {
  read:       { state: 'injected', status: () => 'processing', set: (t) => ({ read_at: t, injected_at: t }) },
  readAged:   { state: 'closed',   status: () => 'done',       set: (t) => ({ read_at: t, injected_at: t }) },
  process:    { state: 'injected', status: () => 'processing', set: (t) => ({ injected_at: t }), bumpAttempts: true },
  // v6.36：终态事件加 touchRead —— 进入终态即"无需再看"，read_at 若为空则一并补标（未读角标归零）。
  //   仅对「未读且正转终态」的行生效（read_at IS NULL 才补），不影响未读的正常待办 task。
  reply:      { state: 'closed',   status: (r) => (r.type === 'task' ? 'closed' : 'done'), set: (t) => ({ replied_at: t }), touchRead: true },
  replyAwait: { state: 'consumed', status: () => 'awaiting_close', set: (t) => ({ replied_at: t }) },
  cancel:     { state: 'closed',   status: () => 'cancelled',  set: (t) => ({ replied_at: t }), touchRead: true },
  supersede:  { state: 'closed',   status: () => 'superseded', set: () => ({}), touchRead: true },
  stale:      { state: 'expired',  status: () => 'stale',      set: () => ({}), touchRead: true },
  expire:     { state: 'expired',  status: () => 'expired',    set: (t) => ({ replied_at: t, wake_intent: 'actionable', notify_target: 'actionable', is_pending: 1 }), touchRead: true },
  fail:       { state: 'failed',   status: () => 'failed',     set: () => ({}), touchRead: true },
  reset:      { state: 'inbox',    status: () => 'pending',    set: () => ({ replied_at: null, injected_at: null }) },
};
function advance(target, event, opts = {}) {
  if (!db) return { changes: 0, blocked: 0, ids: [] };
  const ev = EVENT_STATE[event];
  if (!ev) { try { console.error('[mailbox] advance 未知事件: ' + event); } catch { } return { changes: 0, blocked: 0, ids: [] }; }
  const t = Number.isFinite(opts.now) ? opts.now : nowMs();
  let ids = [];
  try {
    if (typeof target === 'string') ids = [String(target)];
    else if (target && Array.isArray(target.ids)) ids = target.ids.map(String);
    else if (target && target.where) ids = db.prepare(`SELECT id FROM agent_messages WHERE ${target.where}`).all(...(target.params || [])).map((r) => String(r.id));
  } catch (e) { try { console.error('[mailbox] advance 目标解析失败:', e.message); } catch { } return { changes: 0, blocked: 0, ids: [] }; }
  if (!ids.length) return { changes: 0, blocked: 0, ids: [] };
  const onlyIf = opts.onlyIf ? ` AND ${opts.onlyIf}` : '';
  const sel = db.prepare('SELECT id, state, status, type, read_at FROM agent_messages WHERE id=?');
  let changes = 0, blocked = 0; const changedIds = [];
  for (const id of ids) {
    try {
      const row = sel.get(id);
      if (!row) continue;
      const cur = row.state ? String(row.state) : statusToState(row.status);
      const nxt = (typeof ev.state === 'function') ? ev.state(row) : ev.state;
      const curRank = STATE_RANK[cur] != null ? STATE_RANK[cur] : 0;
      const nxtRank = STATE_RANK[nxt] != null ? STATE_RANK[nxt] : 0;
      // 单调不可逆（V1）：①终态为吸收态，除显式 reset 外一律不改写（防把 closed 降级/覆盖）；
      //   ②新状态秩 < 当前秩 → 拒绝降级。
      if (event !== 'reset' && (_isTerminalState(cur) || nxtRank < curRank)) { blocked++; continue; }
      const setObj = Object.assign({ state: nxt, status: opts.statusOverride || ev.status(row) }, ev.set ? ev.set(t, row) : {});
      // v6.49e（2026-09-30）：进入终态即"不再待办" → 事件未显式置 is_pending 时清 0。
      //   此前 close 后 is_pending 仍为 1，与 state=closed 矛盾，被续跑/巡检判据误读为"仍有待办"。
      if (_isTerminalState(nxt) && setObj.is_pending == null) setObj.is_pending = 0;
      // v6.36：终态事件补标 read_at（仅当为空）——终态即"无需再看"，未读角标应归零；未读的正常待办 task 不受影响。
      if (ev.touchRead && row.read_at == null) setObj.read_at = t;
      // v6.50-补（写侧不变量）：进入「已注入(injected)/已消费(consumed)」的行，read_at 须与 state 同步置位
      //   （read_at 为 state 的派生镜像；漏写会让读 read_at 的 UI 角标与状态机权威漂移 → 未读清不掉，真机 m-mun19pz7）。
      if (READ_MIRROR_STATES.has(nxt) && setObj.read_at == null && row.read_at == null) setObj.read_at = t;
      const cols = Object.keys(setObj);
      const sql = `UPDATE agent_messages SET ${cols.map((c) => `${c}=?`).join(', ')}${ev.bumpAttempts ? ', attempts=attempts+1' : ''} WHERE id=?${onlyIf}`;
      const r = db.prepare(sql).run(...cols.map((c) => setObj[c]), id, ...(opts.params || []));
      if (r.changes) { changes++; changedIds.push(id); }
    } catch (e) { try { console.error('[mailbox] advance 行失败 ' + id + ': ' + e.message); } catch { } }
  }
  return { changes, blocked, ids: changedIds };
}
/** P1 灰度比对：新 state 与旧 status 映射不一致的行数（应恒为 0；>0 即双写漂移）。 */
function verifyStateConsistency() {  if (!db) return { mismatches: 0, rows: [] };
  try {
    const rows = db.prepare('SELECT id, state, status FROM agent_messages WHERE state IS NOT NULL').all()
      .filter((r) => statusToState(r.status) !== String(r.state));
    return { mismatches: rows.length, rows: rows.slice(0, 20) };
  } catch { return { mismatches: -1, rows: [] }; }
}
/** P2 灰度比对：wake_intent 与拆列（notify_target / is_pending）不一致的行数（应恒为 0）。 */
function verifyWakeSplitConsistency() {
  if (!db) return { mismatches: 0, rows: [] };
  try {
    const rows = db.prepare('SELECT id, type, wake_intent, notify_target, is_pending, state, status FROM agent_messages WHERE notify_target IS NOT NULL OR is_pending IS NOT NULL').all()
      .filter((r) => {
        // v6.49e：终态行（closed/expired/failed）is_pending 已清 0，不再由 (type,wakeIntent) 派生 → 不参与比对
        if (_isTerminalState(r.state ? String(r.state) : statusToState(r.status))) return false;
        const nt = (r.notify_target != null) ? String(r.notify_target) : null;
        const expNt = (r.wake_intent === 'actionable') ? 'actionable' : null;
        const expPend = pendingByMessage(r.type, r.wake_intent) ? 1 : 0;
        return nt !== expNt || Number(r.is_pending) !== expPend;
      });
    return { mismatches: rows.length, rows: rows.slice(0, 20) };
  } catch { return { mismatches: -1, rows: [] }; }
}
/** P1 §三.7 存量收敛：把非终态滞留行收敛——reply/ack/notify（已读→closed/未读→inbox）+ result 类已读且已注入→closed，目标 processing=0。 */
function sweepConvergeLegacy() {
  if (!db) return 0;
  const now = nowMs(); let n = 0;
  try {
    const notIn = TERMINAL_STATUS.map(() => '?').join(',');
    const r1 = db.prepare(`UPDATE agent_messages SET state='closed', status='done', replied_at=COALESCE(replied_at, ?)
        WHERE type IN ('reply','ack','notify') AND read_at IS NOT NULL AND status NOT IN (${notIn})`).run(now, ...TERMINAL_STATUS);
    n += r1.changes || 0;
    const r2 = db.prepare(`UPDATE agent_messages SET state='inbox', status='pending'
        WHERE type IN ('reply','ack','notify') AND read_at IS NULL AND status NOT IN (${notIn})`).run(...TERMINAL_STATUS);
    n += r2.changes || 0;
    // P1 遗留2（V5）：**result 类**已读且已注入的滞留（注入过某回合上下文却未终态化）→ 终态。
    //   经 advance（type!=='task' → status='done'，state='closed'，置 replied_at），受单调/吸收态保护。
    const _rids = db.prepare(`SELECT id FROM agent_messages
        WHERE type='result' AND read_at IS NOT NULL AND injected_at IS NOT NULL AND replied_at IS NULL
          AND status NOT IN (${notIn})`).all(...TERMINAL_STATUS).map((r) => String(r.id));
    if (_rids.length) { const _ar = advance({ ids: _rids }, 'reply', { now }); n += _ar.changes; }
  } catch (e) { try { console.error('[mailbox] 存量收敛失败:', e.message); } catch { } }
  return n;
}

/** P1 遗留3（2026-09-29·state/status 双写不同步修正）：把"status 已终态但 state 非终态"的存量行
 *  advance 到对应终态（走状态机，受单调/吸收态保护），使双写一致。返回修正数。
 *  判据：`SELECT count(*) FROM agent_messages WHERE status IN('done','closed','expired','failed','cancelled') AND state NOT IN('closed','expired','failed')` == 0。 */
function reconcileStateStatus() {
  if (!db) return 0;
  const now = nowMs(); let n = 0;
  try {
    const rows = db.prepare("SELECT id, status FROM agent_messages WHERE status IN('done','closed','expired','failed','cancelled') AND (state IS NULL OR state NOT IN('closed','expired','failed'))").all();
    for (const r of rows) {
      const st = String(r.status);
      const ev = (st === 'expired') ? 'expire' : (st === 'failed' ? 'fail' : (st === 'cancelled' ? 'cancel' : 'reply'));
      // 走状态机：injected(1)→closed/expired/failed(3) 单调递增，必放行；statusOverride 保原终态语义。
      n += advance(String(r.id), ev, { now, statusOverride: st }).changes;
    }
  } catch (e) { try { console.error('[mailbox] state/status 一致性修正失败:', e.message); } catch { } }
  return n;
}

function markRead(ids) {
  if (!db || !ids || !ids.length) return 0;
  const t = nowMs();
  const r = advance({ ids: ids.map(String) }, 'read', { now: t });
  const n = r.changes;
  if (n > 0) emitMailboxEvent('mailbox-consumed', { role: selfRole(), ids: ids.map(String), count: n, ts: t });
  return n;
}

function markProcessing(ids) {
  if (!db || !ids || !ids.length) return 0;
  const r = advance({ ids: ids.map(String) }, 'process', {});
  return ids.length;
}

/** v6.9：仅对**尚未回复**（replied_at IS NULL）的消息补标已回（幂等，不覆盖已有 replied_at）。
 *  用途：回合被中断/异常结束时，对本回合已消费的入站 task 补回写，防 listPendingForSession 当"假待办"引发续跑循环。 */
function markRepliedIfUnreplied(ids) {
  if (!db || !ids || !ids.length) return 0;
  const now = nowMs();
  const r = advance({ ids: ids.map(String) }, 'reply', { now, onlyIf: 'replied_at IS NULL' });
  if (r.changes > 0) emitMailboxEvent('mailbox-replied', { role: selfRole(), ids: r.ids, count: r.changes, ts: now });
  return r.changes;
}

function reconcileInterruptedInbound() {
  if (!db) return 0;
  const role = selfRole();
  if (!role) return 0;
  let n = 0; const now = nowMs();
  try {
    // P1：收口到 advance（'reply' → task 关单 closed / 其余 done；'reset' → 回 inbox）
    const r1 = advance({ where: "to_id=? AND replied_at IS NULL AND status='processing' AND read_at IS NOT NULL", params: [String(role)] }, 'reply', { now });
    n += r1.changes;
    const r2 = advance({ where: "to_id=? AND replied_at IS NULL AND status='processing' AND read_at IS NULL", params: [String(role)] }, 'reset', { now });
    n += r2.changes;
  } catch (e) { try { console.error('[mailbox] 启动对账失败:', e.message); } catch { } }
  return n;
}

/** P2b-7：统一终态语义 + 防降级。
 *  根因：回合收尾 auto-reply 路径 `mb.markReplied(ids)` 旧实现 `SET status='done'` **无条件**，
 *  会把 result 落库时 `closeTaskByCid` 已置的 'closed' 覆盖为 'done'（真机竞态：收尾晚于 result ~1.1s）→ 'closed' 语义丢失。
 *  修复：① task 已关单统一为 'closed'（非 'done'）；② **绝不改写已终态行**（防把 closed/cancelled 等降级）。 */
function markReplied(id) {
  if (!db || !id) return;
  const r = advance(String(id), 'reply', { now: nowMs() });
  if (r.changes) emitMailboxEvent('mailbox-replied', { role: selfRole(), msgId: String(id), ts: nowMs() });
}

function markDelivered(id, ok) {
  if (!db || !id) return;
  db.prepare('UPDATE agent_messages SET delivered=?, attempts=attempts+1 WHERE id=?').run(ok ? 1 : 0, String(id));
  // v6阶段3：投递失败且 attempts≥上限 → 死信 status='failed'（只改状态，内容不动；可 retry 重投）
  if (!ok) {
    try {
      // P1：收口（'fail' → 终态 failed），仅当 attempts 达上限且非终态。
      advance(String(id), 'fail', { onlyIf: 'attempts>=?', params: [maxAttempts()] });
    } catch { }
  }
}

/** v6.9：把「陈年非动作类」(reply/ack/notify 且 ts 早于 staleTaskMs) 未读补标 read_at。
 *  这些消息不被注入（fetchUnreadForSession 过滤）、也不需处理，read_at 若永为 NULL 会让
 *  countUnread 永久虚高（顶栏角标不消）。补标后历史脏数据自然收敛。返回补标条数。 */
function markAgedNonActionRead() {
  if (!db) return 0;
  try {
    const notIn = NON_ACTION_TYPES.map(() => '?').join(',');
    const cutoff = Date.now() - staleTaskMs();
    // P1：收口（'readAged' → 终态 closed；这些消息设计上不注入、无需回复）
    const r = advance({ where: `read_at IS NULL AND type IN (${notIn}) AND ts < ?`, params: [...NON_ACTION_TYPES, cutoff] }, 'readAged', {});
    return r.changes;
  } catch { return 0; }
}

/** v6.50（定案 C/D·read 语义="已展示"）：**角色级**静默收口"未读的不可唤醒知情类"（reply/ack/notify/**result**，v6.53b）。
 *  仅当 age>=minAgeMs（默认 60s，保证 /api/mailbox/event 的 SSE mailbox-message 已上屏）才标读；
 *  显式 wake_intent/notify_target='actionable' 的不收（那是动作类）；被排除的会话（运行中）不收。
 *  语义：不再起回合、不驱动唤醒 → 只把"已展示但无回合可消费"的回执收口，根治"未读残留"。
 *  @returns {number} 收口条数 */
function sweepSilentRead(role, opts = {}) {
  if (!db || !role) return 0;
  try {
    const minAge = Number.isFinite(Number(opts && opts.minAgeMs)) ? Math.max(0, Number(opts.minAgeMs)) : 60000;
    const ex = Array.isArray(opts && opts.excludeSessionIds) ? opts.excludeSessionIds.map(String).filter(Boolean) : [];
    // v6.53b：类型集 = 所有不可唤醒知情类（{reply,ack,notify,result}，单一权威 NON_WAKEABLE_TYPES_SQL）。
    const notIn = NON_WAKEABLE_TYPES_SQL.map(() => '?').join(',');
    const exClause = ex.length ? ` AND (to_session_id IS NULL OR to_session_id NOT IN (${ex.map(() => '?').join(',')}))` : '';
    // v6.53a（2026-09-30）：**只收口"已兜底唤醒过"的行**（id ∈ silent_wake_log）；尚未兜底者留待兜底 sweep，
    //   防静默标读抢跑（60s 标读 < 兜底阈值）致兜底条件 read_at IS NULL 永不满足（tester 实测漏收未治愈）。
    //   兜底唤醒后该行入 silent_wake_log → 后续 sweep 即可正常静默收口；≥30min 的老行仍由 markAgedNonActionRead 终极收口（不会永久残留）。
    const r = advance({
      where: `COALESCE(state,'inbox')='inbox' AND type IN (${notIn}) AND ts <= ? AND to_id=?`
        + ` AND (COALESCE(notify_target,'')<>'actionable' AND COALESCE(wake_intent,'')<>'actionable')`
        + ` AND id IN (SELECT msg_id FROM silent_wake_log)${exClause}`,
      params: [...NON_WAKEABLE_TYPES_SQL, Date.now() - minAge, String(role), ...ex],
    }, 'readAged', {});
    return r.changes;
  } catch { return 0; }
}

/** v6.35 兜底 sweep：**已读但非终态**的信息类（reply/ack/notify）aging 超阈值 → 走状态机收口。
 *  补 markAgedNonActionRead 只看 `read_at IS NULL` 的空白：已读(read_at 非空)却未收口的行原先**永不收敛**
 *  （只有重启时 reconcileInterruptedInbound 才清）。周期/懒调用 → 此类无需重启即自愈。
 *  幂等、受 advance 单调/吸收态保护；默认按本实例 role 收敛（to_id=selfRole）。返回收口条数。 */
let _lastSweepReadInfo = 0;
function sweepReadInfoConverge(opts = {}) {
  if (!db) return 0;
  const now = nowMs();
  if (opts.throttle !== false && (now - _lastSweepReadInfo) < 60000) return 0;
  _lastSweepReadInfo = now;
  const role = (opts.role === null) ? null : (opts.role || selfRole());
  const ageMs = Number.isFinite(opts.olderThanMs) ? Number(opts.olderThanMs) : staleTaskMs();
  const cutoff = now - ageMs;
  const notIn = TERMINAL_STATUS.map(() => '?').join(',');
  try {
    const sql = `SELECT id FROM agent_messages
        WHERE type IN ('reply','ack','notify') AND read_at IS NOT NULL AND read_at < ?
          AND replied_at IS NULL AND status NOT IN (${notIn})${role ? ' AND to_id=?' : ''}`;
    const params = [cutoff, ...TERMINAL_STATUS];
    if (role) params.push(String(role));
    const ids = db.prepare(sql).all(...params).map((r) => String(r.id));
    if (!ids.length) return 0;
    const r = advance({ ids }, 'reply', { now });
    return r.changes;
  } catch { return 0; }
}

/** v6阶段3：超时 task（超过 staleTaskMs 仍未回，且其后无回执）→ status='stale'。返回标记条数。
 *  懒计算：由 queue/listPending 读路径顺带调用（节流 60s），或 server 周期调用；只改状态不改内容。 */
let _lastSweepStale = 0;
function sweepStale(opts = {}) {
  if (!db) return 0;
  const now = Date.now();
  if (opts.throttle !== false && (now - _lastSweepStale) < 60000) return 0;
  _lastSweepStale = now;
  try { markAgedNonActionRead(); } catch { }   // v6.9：顺手补标陈年非动作类未读，防顶栏角标不消
  try { sweepReadInfoConverge({ throttle: false }); } catch { }   // v6.35：顺手收敛"已读但非终态"的信息类（无需重启自愈）
  const notIn = NON_ACTION_TYPES.map(() => '?').join(',');
  const cutoff = now - staleTaskMs();
  try {
    // 未回 = 其后无来自 to_id 的、归属本会话(to_session_id=from_session_id?) 的回执；简化为"其后无任何 to_id 发出的消息"
    // P1：收口到 advance（'stale' → 终态 expired 语义）
    const _ids = db.prepare(`SELECT id FROM agent_messages WHERE type NOT IN (${notIn}) AND status IN ('pending','processing') AND ts < ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_messages r WHERE r.from_id=agent_messages.to_id AND r.ts > agent_messages.ts
        )`).all(...NON_ACTION_TYPES, cutoff).map((r) => String(r.id));
    const _r = advance({ ids: _ids }, 'stale', { now });
    return _r.changes;
  } catch { return 0; }
}

/** GAP-1（P2b-7 批）：deadline 过期扫描——未终态 task 且 deadline < now → status='expired' + 唤醒发起方一次
 *  （向发起方发一条带 cid 的 result，显式 wake_intent='actionable'，走 result 语义）。仅主引擎周期调用（共享库防重复）。 */
let _lastSweepExpired = 0;
function sweepExpired(opts = {}) {
  if (!db) return 0;
  const now = nowMs();
  if (opts.throttle !== false && (now - _lastSweepExpired) < 60000) return 0;
  _lastSweepExpired = now;
  const notIn = TERMINAL_STATUS.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db.prepare(`SELECT id, correlation_id, from_id, to_id, from_session_id FROM agent_messages
        WHERE type='task' AND deadline IS NOT NULL AND deadline < ? AND status NOT IN (${notIn})`)
      .all(now, ...TERMINAL_STATUS);
  } catch { return 0; }
  let n = 0;
  for (const r of rows) {
    try {
      const _r = advance(String(r.id), 'expire', { now, onlyIf: `status NOT IN (${notIn})`, params: [...TERMINAL_STATUS] });
      if (!_r.changes) continue;
      n++;
      const cid = r.correlation_id || r.id;
      try {
        // 走 result 语义：带 cid 通知发起方；显式 wake_intent='actionable' 确保唤醒一次（task 已 expired 终态，closeTaskByCid 不再命中）。
        //  v6.28：**带上原派活会话**（toSessionId=r.from_session_id）——原先不传 → to_session_id=NULL → 该通知对该 role
        //    的**所有会话**可见（fetchUnreadForSession/listPendingForSession 都含 `OR to_session_id IS NULL`）→ 多会话重复注入。
        sendMessage({ from: String(r.to_id), to: String(r.from_id), type: 'result',
          correlationId: String(cid), outcome: 'failed', sysNotice: true,
          toSessionId: r.from_session_id || null,
          content: `任务 ${cid} 已超期未完成（deadline 已过），标记 expired。` });
      } catch { }
      emitMailboxEvent('mailbox-replied', { role: selfRole(), correlationId: String(cid), expired: true, ts: now });
    } catch { }
  }
  return n;
}

/** P0(c)：收口催办——扫 `status='awaiting_close'`（已交付、未收口）超 N 分钟 → 提醒**发起方**一次。
 *  复用主线 60s sweep 周期调用（不新增心跳/定时器）。幂等：close_nudged_at 非空即不再催（同一任务只提醒一次）。
 *  提醒走 result 语义（带 cid + wakeIntent='actionable'，唤醒发起方一次；发起方收口后置 closed=终态 → 不再命中）。 */
let _lastSweepAwaitingClose = 0;
function sweepAwaitingClose(opts = {}) {
  if (!db) return 0;
  const now = nowMs();
  if (opts.throttle !== false && (now - _lastSweepAwaitingClose) < 60000) return 0;
  _lastSweepAwaitingClose = now;
  const waitMs = Number(opts.waitMs != null ? opts.waitMs : (cfg().mailboxAwaitingCloseNudgeMs != null ? cfg().mailboxAwaitingCloseNudgeMs : 600000)) || 600000;   // 默认 10 分钟
  const cutoff = now - waitMs;
  let rows = [];
  try {
    rows = db.prepare(`SELECT id, correlation_id, from_id, to_id, from_session_id FROM agent_messages
        WHERE type='task' AND status='awaiting_close' AND close_nudged_at IS NULL
          AND replied_at IS NOT NULL AND replied_at < ?`).all(cutoff);
  } catch { return 0; }
  let n = 0;
  for (const r of rows) {
    try {
      // 原子占位：仅首个执行者能置 close_nudged_at（防并发重复催办）。
      const c = db.prepare(`UPDATE agent_messages SET close_nudged_at=?
          WHERE id=? AND status='awaiting_close' AND close_nudged_at IS NULL`).run(now, String(r.id)).changes;
      if (!c) continue;
      n++;
      const cid = r.correlation_id || r.id;
      try {
        sendMessage({ from: String(r.to_id), to: String(r.from_id), type: 'result',
          correlationId: String(cid), outcome: 'done', sysNotice: true,
          toSessionId: r.from_session_id || null,
          content: `任务 ${cid} 已完成但尚未收口（已等待超 ${Math.round(waitMs / 60000)} 分钟），请及时处理（部署/重启/关单）。` });
      } catch { }
      emitMailboxEvent('mailbox-awaiting-close-nudge', { role: selfRole(), correlationId: String(cid), ts: now });
    } catch { }
  }
  return n;
}

/** GAP-2：retention 冷表——已闭环 task 及其 result 超 N 天 → 移入 agent_messages_archive + 主表删；
 *  ack/notify 超 7 天删；**未闭环永不自动清**。开关 mailboxRetentionDays（默认 30）。仅主引擎周期调用。 */
function sweepRetention(opts = {}) {
  if (!db) return { moved: 0, deleted: 0 };
  const _d = Number(opts.days != null ? opts.days : cfg().mailboxRetentionDays);
  const keepDays = Number.isFinite(_d) && _d > 0 ? _d : 30;
  const now = nowMs();
  const cutClosed = now - keepDays * 86400000;
  const cutNotice = now - 7 * 86400000;
  const closedSet = TERMINAL_STATUS.map(() => '?').join(',');
  let moved = 0, deleted = 0;
  try {
    // ① 已闭环 task 及其 result（同 cid）超期 → 归档（先归档后删，原子性由 WAL 事务保证）
    const rows = db.prepare(`SELECT id FROM agent_messages
        WHERE ts < ? AND (
          (type='task' AND status IN (${closedSet}))
          OR (type IN ('result','reply') AND correlation_id IS NOT NULL AND correlation_id IN (
                SELECT correlation_id FROM agent_messages
                WHERE type='task' AND status IN (${closedSet}) AND correlation_id IS NOT NULL AND ts < ?))
        )`).all(cutClosed, ...TERMINAL_STATUS, cutClosed, ...TERMINAL_STATUS);
    const arch = db.prepare('INSERT OR REPLACE INTO agent_messages_archive SELECT * FROM agent_messages WHERE id=?');
    const del = db.prepare('DELETE FROM agent_messages WHERE id=?');
    db.exec('BEGIN');
    try {
      for (const r of rows) { try { arch.run(String(r.id)); del.run(String(r.id)); moved++; } catch { } }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { } moved = 0; }
    // ② ack/notify 超 7 天 → 删（不归档；纯通知无审计价值）
    const d2 = db.prepare("DELETE FROM agent_messages WHERE type IN ('ack','notify') AND ts < ?").run(cutNotice);
    deleted += d2.changes || 0;
  } catch { }
  return { moved, deleted };
}

/** v6阶段3：队列查询（stale/failed 等按状态），供 GET /api/mailbox/queue。 */
function listQueue(status, limit = 100) {
  if (!db) return [];
  const st = String(status || 'failed');
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  try {
    // v6.8：status='delivered0' → 观测"未投递成功"的消息（供主我观测自动重投待办）
    // v6.27（2026-09-22）：补 `AND read_at IS NULL` —— 对齐 redeliverPending(L1202) 口径。
    //   原缺陷：未排除已闭环/已读 → 只统计 status，DB 里 delivered=0 的残留（多为已 read+replied 的
    //   closed/done）被误报为"未投递待办"，前端 refreshUndelivered(limit=1) 只要有一条就恒显 1。
    //   口径：已读 = 对端已确认收到，绝不算"未投递"。
    if (st === 'delivered0') {
      return db.prepare(`SELECT * FROM agent_messages WHERE delivered=0 AND status NOT IN ('done','failed','processing') AND read_at IS NULL ORDER BY ts DESC LIMIT ?`).all(lim);
    }
    return db.prepare(`SELECT * FROM agent_messages WHERE status=? ORDER BY ts DESC LIMIT ?`).all(st, lim);
  } catch { return []; }
}

/** v6阶段3：重投一条死信（重置 attempts=0/status='pending' → 重新 deliver）。返回 {ok, delivered}。 */
async function retry(id) {
  if (!db || !id) return { ok: false, error: '未初始化/缺 id' };
  const m = getMessage(id);
  if (!m) return { ok: false, error: '消息不存在' };
  try { advance(String(id), 'reset', {}); db.prepare('UPDATE agent_messages SET attempts=0, delivered=0 WHERE id=?').run(String(id)); } catch { }
  const role = m.to_id; const a = getAgent(role);
  if (!a) return { ok: false, error: `未注册 role：${role}` };
  const r = await deliver(role, m.content, m.to_session_id || null, true);
  markDelivered(id, !!r.ok);
  return { ok: true, delivered: !!r.ok, status: r.ok ? 'pending' : (m.status || 'pending') };
}

/** 待回复（replied_at IS NULL）。 */
function listPending(role) {
  if (!db || !role) return [];
  return db.prepare('SELECT * FROM agent_messages WHERE to_id=? AND replied_at IS NULL ORDER BY ts ASC').all(String(role));
}

function listPendingForSession(role, sessionId, opts = {}) {
  if (!db || !role) return [];
  // v6.1 修复：收窄"待办"口径（仅被续跑使用）——
  //  ① reply/ack/notify 本就不需回复、replied_at 永为 NULL → 不能算"待办"（否则正常结束每轮重灌历史）；
  //  ② 僵尸过滤：只认 STALE_TASK_MS(30min) 内的消息（与 linksWithStatus 同口径）。
  //  v6.24 根因#3 修复：追加 status 过滤——已被本回合 markProcessing(status='processing') 或已 done/failed/stale
  //    的 task **不再算待办**，防"同一 task 在多轮续跑里被反复注入（重放）"。开关 mailboxResumeExcludeProcessing(默认真)。
  //  v6.28（2026-09-29）根因#4 修复：**非动作类 result 也不该算待办**。原 `type NOT IN ('reply','ack','notify')`
  //    漏了 `result`（isActionableType 早已把"非 wake_intent=actionable 的 result"判为知情类，见 runtime.js:2217）
  //    → 口径不一致：一条普通 result 回执会被 [信箱续跑] 当"待办"整条注入，与它作为"应答"的语义矛盾，表现为
  //    "同一条回执被反复注入"。修法：与 isActionableType 对齐——仅 `wake_intent='actionable'` 的 result 仍算待办，
  //    其余 result 排除。另补 status `superseded`（改版占位行 replied_at 仍为 NULL，会被误当待办）。
  //  v6.34（2026-09-29·现象A/B 根治）：reply/ack/notify **无条件**排除，即便 wake_intent='actionable'。
  //    原 `... OR wake_intent='actionable'` 让"带 actionable 的回执"（发送侧 wakeDecision 为唤醒发起方
  //    而置位）被判成待办 → [信箱续跑] 二次注入（同一回执既在回合起始未读前缀、又被续跑批量注入=重复投递），
  //    且被 markProcessing 置 'processing' 后 replied_at 仍为 NULL → **永久滞留"处理中"**（现象B）。
  //    reply/ack/notify 是"仅供知晓"信息类：其唤醒职责已由发送侧 wakeDecision 单独完成，**绝不作为待办重放**。
  const staleCut = Date.now() - staleTaskMs();
  // v6.50（定案 A/B）：未消费判据从**权威 state** 派生（'inbox'=未注入/未收口）；"是否待办"由 classify() 统一精筛。
  const rows = db.prepare(`SELECT * FROM agent_messages
      WHERE to_id=? AND COALESCE(state,'inbox')='inbox' AND injected_at IS NULL AND replied_at IS NULL AND (to_session_id=? OR to_session_id IS NULL)
        AND ts >= ?
      ORDER BY ts ASC`).all(String(role), sessionId || '', staleCut);
  // v6.50-补：续跑"待办"取 classify().waitable —— 静默类（reply/ack/notify）**无条件排除**（即便 wake_intent='actionable'）。
  return _claimNullSession(role, sessionId, rows.filter((r) => classify(r).waitable), opts);
}

function getMessage(id) {
  if (!db || !id) return null;
  return db.prepare('SELECT * FROM agent_messages WHERE id=?').get(String(id)) || null;
}

/** 判断 fromRole 在 sinceTs 之后是否已向 toRole 发过消息（用于避免重复自动回执）。 */
function hasReplySince(fromRole, toRole, sinceTs) {
  if (!db) return false;
  const r = db.prepare('SELECT COUNT(*) AS c FROM agent_messages WHERE from_id=? AND to_id=? AND ts>=?')
    .get(String(fromRole), String(toRole), Number(sinceTs) || 0);
  return !!(r && r.c > 0);
}

// ———————— 会话映射（懒创建） ————————

function linkSession(mainSessionId, peerRole, peerSessionId, peerBaseUrl) {
  if (!db) return null;
  const now = nowMs();
  db.prepare(`INSERT INTO session_links
      (id,main_session_id,peer_role,peer_session_id,peer_base_url,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(main_session_id, peer_role) DO UPDATE SET
        peer_session_id=excluded.peer_session_id, peer_base_url=excluded.peer_base_url, updated_at=excluded.updated_at`)
    .run(newId('lk'), String(mainSessionId), String(peerRole), String(peerSessionId), peerBaseUrl || null, now, now);
  return resolveSession(mainSessionId, peerRole);
}

function resolveSession(mainSessionId, peerRole) {
  if (!db || !mainSessionId || !peerRole) return null;
  return db.prepare('SELECT * FROM session_links WHERE main_session_id=? AND peer_role=?')
    .get(String(mainSessionId), String(peerRole)) || null;
}

function listLinks(mainSessionId) {
  if (!db) return [];
  if (!mainSessionId) return db.prepare('SELECT * FROM session_links').all();
  return db.prepare('SELECT * FROM session_links WHERE main_session_id=?').all(String(mainSessionId));
}

/** 陈旧僵尸 task 阈值：超过此毫秒数仍未回的 task 不再计入 busy（防 09-11 那种僵尸永久卡住状态）。*/
const STALE_TASK_MS = 30 * 60 * 1000;
/** v6阶段3：task 超时阈值（默认对齐 STALE_TASK_MS，可经 config.mailboxStaleTaskMs 覆盖）。 */
function staleTaskMs() { const v = Number(cfg().mailboxStaleTaskMs); return (Number.isFinite(v) && v > 0) ? v : STALE_TASK_MS; }
/** busy 活跃窗口（默认 5min）：本会话与该 role 最近往来的新鲜度阈值。0=恒 false；很大=长久 true。 */
// v6.4：busy 真实回合状态口径的 TTL 与兜底入站窗口（替换旧的活跃窗口 mailboxBusyWindowMs）
const BUSY_TTL_MS = 30 * 60 * 1000;      // busy_at 新鲜度上限：超此视为陈旧（防崩溃卡死）
function busyTtlMs() { const v = Number(cfg().mailboxBusyTtlMs); return (Number.isFinite(v) && v > 0) ? v : BUSY_TTL_MS; }
const BUSY_INBOUND_MS = 90 * 1000;       // 兜底：老版本对端未上报 busy_session 时，最近入站(该role→本会话)新鲜窗口
function busyInboundMs() { const v = Number(cfg().mailboxBusyInboundMs); return (Number.isFinite(v) && v >= 0) ? v : BUSY_INBOUND_MS; }

/** 单一源 busy 判定：
 *  ① 该 role 有真实回合上报（busy_session 非空）→ busy_at 在 TTL 内即 busy；
 *  ② 否则退化为「该 role→会话最近入站 ts 在小窗口内」；无入站/窗口≤0 → false。
 *  linksWithStatus 与 server.js summary 共用本函数，保证两端口径一致。 */
function computeBusy(ag, inboundTs, peerSessionId) {
  const now = Date.now();
  if (ag && ag.busy_session != null && ag.busy_session !== '') {
    // busy_session 存的是"该实例正在跑的会话id"；仅当等于本会话对端 link 的 peer_session_id 时才表示"它在为本会话工作"。
    if (peerSessionId != null && String(ag.busy_session) !== String(peerSessionId)) return false;
    return (now - (ag.busy_at || 0)) < busyTtlMs();
  }
  const ib = busyInboundMs();
  if (ib <= 0 || !inboundTs) return false;
  return (now - inboundTs) < ib;
}
/** v6阶段3：投递失败达此次数 → 死信 status='failed'（默认 3，可配置）。 */
function maxAttempts() { const v = Number(cfg().mailboxMaxAttempts); return (Number.isFinite(v) && v > 0) ? Math.floor(v) : 3; }
/** v6阶段2：priority=high 的唤醒合并窗口（默认 200ms，可配置）。 */
function highCoalesceMs() { const v = Number(cfg().mailboxHighCoalesceMs); return (Number.isFinite(v) && v >= 0) ? v : 200; }
/** 不需要对方再回复的消息类型：reply（对回执的应答）/ ack / notify —— 不参与 busy。*/
const NON_ACTION_TYPES = ['reply', 'ack', 'notify'];
/** v6.50（定案 A/E）：默认**不唤醒**的类型（知情类）——result 亦默认知情，仅显式 actionable 才动作。
 *  与 NON_ACTION_TYPES 的区别：后者=前端角标/老化收口口径（结果类不参与），前者=唤醒口径。 */
const NON_WAKE_TYPES = ['reply', 'ack', 'notify', 'result'];
/** v6.50-补（判据单源·定案）：SQL 层"静默类型"唯一派生源——清单由 classify() 判定，杜绝 SQL 内硬编码。
 *  countUnread / fetchUnreadForSession 等未读口径一律经 nonActionSql() 生成占位符，与 JS 判据同源；
 *  改类型的静默语义只需改 classify()，SQL 侧自动跟随（消除散点）。 */
const SILENT_TYPES_SQL = NON_ACTION_TYPES.filter((t) => classify({ type: t }).autoRead);
/** v6.53b（2026-09-30）：知情类**兜底/静默收口**覆盖的类型集——"所有**不可唤醒**类型"（单一权威，派生自 classify）。
 *  = {reply,ack,notify,**result**}。与 SILENT_TYPES_SQL(=角标/未读口径，不含 result) 的区别：
 *  本集用于"空闲兜底唤醒 + 静默收口"，把不可唤醒的 result 也纳入，避免其落在两套之外**无人管**（主我实测漏收 m-muo98unn）。
 *  行级还须满足 notify_target/wake_intent 非 'actionable'（不可唤醒）——见各处 where。 */
const NON_WAKEABLE_TYPES_SQL = NON_WAKE_TYPES.filter((t) => !classify({ type: t }).wakeable);
/** 生成"非静默类型"SQL 片段 + 参数（供未读类查询复用，判据派生自 classify）。 */
function nonActionSql(col = 'type') {
  const ph = SILENT_TYPES_SQL.map(() => '?').join(',');
  return { sql: `${col} NOT IN (${ph})`, params: SILENT_TYPES_SQL.slice() };
}

/**
 * 本会话关联雷影的状态聚合（只读）——供 GET /api/sessions/:id/links 使用。
 * busy（v6.4·真实回合状态，替换全部启发式）：该 role 正在跑【与本会话配对的对端会话】的回合 ——
 *   读 agents.busy_session === lk.peer_session_id 且 busy_at 未超 TTL(mailboxBusyTtlMs，默认30min)。
 *   雷影在 runtime 回合开始置忙、finally 收尾置空（setAgentBusy），是**准确信号**而非"有往来≈在干活"的启发式。
 *   兜底：老版本对端未上报 busy_session 时，退化为"最近入站(该 role→本会话)在 mailboxBusyInboundMs(默认90s)内"。
 * busyRaw（调试·口径不变）：原口径 outboundPending>0（含 reply/僵尸）。
 * busyPending（调试·口径不变）："task 之后该 role 无回执"的配对判定计数（含 NOT EXISTS SQL，仅供排查，不再驱动 busy）。
 * outboundPending（调试）：原口径未回消息条数（replied_at IS NULL 且 status∈pending/processing）。
 * unread：该 role → 本会话(read_at IS NULL) 的回执条数（语义不变）。
 * lastTs：该 role 与本会话往来的最新时间戳（无往来则回退 link.updated_at）。
 * 本模块约束：不出现任何具体角色名常量，一律按 role 变量走表查询。
 */
function linksWithStatus(mainSessionId) {
  if (!db || !mainSessionId) return [];
  const sid = String(mainSessionId);
  const staleCut = Date.now() - staleTaskMs();
  const notIn = NON_ACTION_TYPES.map(() => '?').join(',');
  let links;
  try { links = listLinks(sid); } catch { return []; }
  const out = [];
  for (const lk of links) {
    const role = lk.peer_role;
    let outboundPending = 0, busyPending = 0, unread = 0, lastTs = lk.updated_at || lk.created_at || 0;
    try {
      outboundPending = db.prepare(`SELECT COUNT(*) AS c FROM agent_messages
        WHERE from_session_id=? AND to_id=? AND replied_at IS NULL AND status IN ('pending','processing')`)
        .get(sid, role).c;
    } catch { }
    try {
      // busyPending（调试·口径不变）：需回复的 task + 未超时 + 该 role 在此任务之后未回过消息。
      // v6阶段3追加：此 NOT EXISTS 配对 SQL 已**不再驱动 busy**（busy 改按活跃窗口判定，见下 lastTs），
      //                仅保留用于调试字段 busyPending（前端 commcenter 仍聚合该计数）——故口径保持原样。
      busyPending = db.prepare(`SELECT COUNT(*) AS c FROM agent_messages m
        WHERE m.from_session_id=? AND m.to_id=? AND m.type NOT IN (${notIn})
          AND m.status IN ('pending','processing') AND m.ts >= ?
          AND NOT EXISTS (
            SELECT 1 FROM agent_messages r
            WHERE r.from_id=? AND r.to_session_id=? AND r.ts > m.ts
          )`)
        .get(sid, role, ...NON_ACTION_TYPES, staleCut, role, sid).c;
    } catch { }
    try {
      // v6.50-补：与 countUnread 同源（state 权威 + read_at 镜像）——防"state 已 injected 但 read_at 漏写"致 UI 虚挂未读。
      unread = db.prepare(`SELECT COUNT(*) AS c FROM agent_messages
        WHERE to_session_id=? AND from_id=? AND COALESCE(state,'inbox')='inbox' AND read_at IS NULL`)
        .get(sid, role).c;
    } catch { }
    try {
      const r = db.prepare(`SELECT MAX(ts) AS t FROM agent_messages
        WHERE (from_session_id=? AND to_id=?) OR (to_session_id=? AND from_id=?)`)
        .get(sid, role, sid, role);
      if (r && r.t) lastTs = Math.max(lastTs, r.t);
    } catch { }
    const ag = getAgent(role) || {};
    // v6.x：busy 判定单一源——computeBusy(ag, 该 role→本会话最近入站 ts)，与 server.js summary 同口径。
    let lastInboundTs = null;
    try {
      const r = db.prepare(`SELECT MAX(ts) t FROM agent_messages WHERE from_id=? AND to_session_id=?`).get(role, sid);
      if (r && r.t) lastInboundTs = r.t;
    } catch { }
    const busy = computeBusy(ag, lastInboundTs, lk.peer_session_id);
    out.push({
      role,
      name: ag.name || role,
      domain: ag.domain || '',
      baseUrl: lk.peer_base_url || ag.base_url || '',
      peerSessionId: lk.peer_session_id || null,
      busy,
      busyRaw: outboundPending > 0,
      busyPending,
      outboundPending,
      unread,
      lastTs,
    });
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}
// v5.5.1：并发懒建去重——同一 (fromSessionId, toRole) 在并发/连发时共享同一次 createPeerSession，
// 避免各条消息各自建对端会话 → 保证合并唤醒时全部消息落到同一 to_session_id、均可被读到。
const _peerCreating = new Map();   // key=`${fromSessionId}|${toRole}` -> Promise<sid|null>

async function ensurePeerSession(fromSessionId, toRole, baseUrl, msgId) {
  const key = `${fromSessionId}|${toRole}`;
  let p = _peerCreating.get(key);
  if (!p) {
    p = (async () => {
      let sid = await createPeerSession(toRole, msgSummary(msgId));
      if (!sid) {
        // v6.7：对端未启动 → 惰性拉起后重试一次
        const up = await ensureAgentUp(toRole).catch(() => null);
        if (up && up.ok) sid = await createPeerSession(toRole, msgSummary(msgId));
      }
      if (sid) linkSession(fromSessionId, toRole, sid, baseUrl);
      return sid;
    })().finally(() => { _peerCreating.delete(key); });
    _peerCreating.set(key, p);
  }
  const sid = await p;
  if (sid) { try { db.prepare('UPDATE agent_messages SET to_session_id=? WHERE id=?').run(sid, msgId); } catch { } }
  return sid;
}

// ———————— 投递（HTTP 直投唤醒） ————————

function httpPostJson(baseUrl, pathname, bodyObj, timeoutMs = 300000, extraHeaders = null) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(pathname, baseUrl); } catch (e) { return reject(new Error(`非法 base_url: ${baseUrl}`)); }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, extraHeaders || {}),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 100000) buf += d; });   // SSE 流：有界收集，不无限膨胀
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      res.on('error', (e) => resolve({ status: res.statusCode, body: buf, error: e.message }));
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('投递超时')); } catch { } });
    req.on('error', (e) => reject(e));
    req.end(payload);
  });
}

function httpGetJson(baseUrl, pathname, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(pathname, baseUrl); } catch (e) { return reject(new Error(`非法 base_url: ${baseUrl}`)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 200000) buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      res.on('error', (e) => resolve({ status: res.statusCode, body: buf, error: e.message }));
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(new Error('GET 超时')); } catch { } });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

/** v6.7：探活对端实例（GET /api/health）。通 → true。不抛。 */
async function probeUp(baseUrl, timeoutMs = 2000) {
  if (!baseUrl) return false;
  try { const r = await httpGetJson(baseUrl, '/api/health', timeoutMs); return !!(r && r.status >= 200 && r.status < 300); }
  catch { return false; }
}

/** v6.7：惰性拉起对端实例——发消息时若对端未启动才拉起。
 *  流程：①探活 ②定位实例根(data_dir 的父目录) ③防惊群(30s 内同角色只拉一次) ④spawn(detached,windowsHide,stdio ignore) ⑤轮询探活。
 *  返回 {ok, already?|started?, error?}；绝不抛。开关 mailboxLazyStart=false 时直接返回 skipped（不探活/不拉起）。 */
const _lazyStartTs = new Map();          // role -> 上次拉起时间(ms)，防惊群
const LAZY_START_COOLDOWN_MS = 30000;
async function ensureAgentUp(role) {
  const c = cfg();
  if (c.mailboxLazyStart === false) return { ok: false, skipped: true, error: 'mailboxLazyStart=false（按需拉起已关闭）' };
  const a = getAgent(role);
  if (!a) return { ok: false, error: `未注册的雷影角色：${role}` };
  // 注销/停用防复活：不拉起已停用或已注销的 role
  if (a.retired_at) return { ok: false, error: `角色 ${role} 已注销（retired），不拉起` };
  if (Number(a.enabled) === 0) return { ok: false, error: `角色 ${role} 已停用（disabled），不拉起` };
  if (!a.base_url) return { ok: false, error: `角色 ${role} 未配置 base_url` };
  // ① 探活
  if (await probeUp(a.base_url, 2000)) return { ok: true, already: true };
  // ② 定位实例根（data_dir 的父目录）
  const dataDir = a.data_dir ? String(a.data_dir) : '';
  if (!dataDir) return { ok: false, error: '无法定位实例（缺少 data_dir）' };
  const root = path.dirname(dataDir);
  const serverJs = path.join(root, 'src', 'server.js');
  if (!fs.existsSync(serverJs)) return { ok: false, error: `无法定位实例：${serverJs} 不存在` };
  // ③ 防惊群：30s 内同角色只拉一次（已有则只等待，不重复 spawn）
  const now = Date.now();
  let spawned = false;
  if (now - (_lazyStartTs.get(role) || 0) >= LAZY_START_COOLDOWN_MS) {
    _lazyStartTs.set(role, now);
    try {
      const child = childSpawn(process.execPath, ['src/server.js', '--daemon'], {
        cwd: root, windowsHide: true, detached: true, stdio: 'ignore',
      });
      child.on('error', () => { /* spawn 失败交给轮询探活兜底 */ });
      child.unref();
      spawned = true;
    } catch (e) { return { ok: false, error: `spawn 失败：${e.message}` }; }
  }
  // ④ 轮询探活（每 500ms，最多 mailboxLazyStartTimeoutMs，默认 8000）
  const iv = Number(c.mailboxLazyStartTimeoutMs);
  const timeoutMs = Number.isFinite(iv) && iv > 0 ? iv : 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    if (await probeUp(a.base_url, 1500)) return { ok: true, started: spawned, reused: !spawned, waitedMs: Date.now() - t0 };
  }
  return { ok: false, error: `拉起后 ${timeoutMs}ms 内未探活成功`, started: spawned };
}

/** 探测对端会话是否仍存在（轻量 GET /api/sessions 列表比对）。
 *  返回 'alive'（在）| 'gone'（明确不在）| 'unknown'（网络异常→保守视为仍在，绝不误重建）。 */
async function peerSessionAlive(role, peerSessionId) {
  const a = getAgent(role);
  if (!a || !a.base_url || !peerSessionId) return 'unknown';
  try {
    const r = await httpGetJson(a.base_url, '/api/sessions', 8000);
    if (r.status >= 200 && r.status < 300) {
      let arr = null;
      try { arr = JSON.parse(r.body); } catch { return 'unknown'; }
      if (!Array.isArray(arr)) return 'unknown';
      return arr.some((x) => x && x.id === peerSessionId) ? 'alive' : 'gone';
    }
  } catch { }
  return 'unknown';
}

/**
 * v6.8：启动时自动恢复雷影（无人值守健壮性·A）。
 * 串行探活 agents 表中 enabled 的非-main role，不活则 ensureAgentUp 拉起；每步 sleep 2s 防惊群，整体 ≤60s。
 * 异步、绝不阻塞调用方；开关 mailboxAutoReviveAgents=false 时跳过（opts.force 可强制）。
 * @returns {Promise<{checked:number,started:number,ok:number,failed:number,skipped?:boolean}>} 绝不抛。
 */
async function reviveAgents(opts = {}) {
  const c = cfg();
  const selfRole = (c.agent && c.agent.role) || null;
  if (!db) return { checked: 0, started: 0, ok: 0, failed: 0, skipped: true };
  if (c.mailboxAutoReviveAgents === false && opts.force !== true) return { checked: 0, started: 0, ok: 0, failed: 0, skipped: true };
  const roles = listAgents().filter((a) => a.enabled && !a.is_main && !a.retired_at && a.role && a.role !== selfRole);
  const totalMs = Number.isFinite(Number(opts.totalMs)) && Number(opts.totalMs) > 0 ? Number(opts.totalMs) : 60000;
  const sleepMs = Number.isFinite(Number(opts.sleepMs)) && Number(opts.sleepMs) > 0 ? Number(opts.sleepMs) : 2000;
  const t0 = Date.now();
  let started = 0, ok = 0, failed = 0;
  for (const a of roles) {
    if (Date.now() - t0 > totalMs) { console.log('[revive] 超时(60s)，停止本轮恢复'); break; }
    try {
      if (await probeUp(a.base_url, 2000)) { ok++; console.log(`[revive] ${a.role} ok(already)`); }
      else {
        const r = await ensureAgentUp(a.role);
        if (r && r.ok) { ok++; started++; console.log(`[revive] ${a.role} ok(started)`); }
        else { failed++; console.log(`[revive] ${a.role} fail:${(r && r.error) || '未知'}`); }
      }
    } catch (e) { failed++; console.log(`[revive] ${a.role} fail: ${e.message}`); }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  console.log(`[revive] 完成，检查 ${roles.length}，ok=${ok} started=${started} failed=${failed}，用时 ${Date.now() - t0}ms`);
  return { checked: roles.length, started, ok, failed };
}

/**
 * v6.8 / v6.9：投递失败**尽力唤醒**（无人值守健壮性·B）。
 * 扫描 delivered=0、status NOT IN ('done','failed','processing')、**read_at IS NULL**、ts 在 windowMs（默认24h）内的消息：
 *  - v6.9 语义：**消息一旦落库即视为"已投递"**（对端必能经回合起始未读注入读到）→ 只**尽力发起一次**唤醒
 *    （fire-and-forget，不 await），随即标记 delivered=1，不再重投；对端忙/卡死时不再反复重投（根治 ping-pong）。
 *  - `read_at IS NULL`：对端**已读过**= 已确认收到 → 绝不重投。
 * 幂等：已 delivered/已 done/failed/已读 的绝不重投。开关 mailboxAutoRedeliver=false 时跳过（opts.force 可强制）。
 * @returns {Promise<{scanned:number,redelivered:number,failed:number,skipped?:boolean}>} 绝不抛。
 */
async function redeliverPending(opts = {}) {
  const c = cfg();
  if (!db) return { scanned: 0, redelivered: 0, failed: 0, skipped: true };
  if (c.mailboxAutoRedeliver === false && opts.force !== true) return { scanned: 0, redelivered: 0, failed: 0, skipped: true };
  const now = Date.now();
  const wv = Number(opts.windowMs);
  const winMs = Number.isFinite(wv) && wv > 0 ? wv : 24 * 3600 * 1000;
  const mv = Number(c.mailboxRedeliverMaxAttempts);
  const maxAtt = Number.isFinite(mv) && mv > 0 ? mv : 8;
  let rows = [];
  try {
    // ★安全边界（实测发现）：status='processing' = 接收方已 markProcessing（已收到并在处理），
    //   若纳入重投会造成"重复派单/重复 LLM 回合"。故**排除 processing**（同时排除 done/failed），
    //   只重投真正"未被确认收到"的 pending/stale。
    // v6.9：再加 `AND read_at IS NULL`——对端**已读过**（read_at 已置）= 已确认收到，绝不再重投；
    //   否则对端长回合/卡死时 delivered 久久不置 1，会被反复重投，与"回合起始未读注入"形成双通道重复消费。
    rows = db.prepare(`SELECT * FROM agent_messages
      WHERE delivered=0 AND status NOT IN ('done','failed','processing') AND read_at IS NULL AND ts >= ?
      ORDER BY ts ASC LIMIT ?`).all(now - winMs, Math.max(1, Math.min(500, Number(opts.limit) || 50)));
  } catch { return { scanned: 0, redelivered: 0, failed: 0 }; }
  let ok = 0, fail = 0;
  for (const m of rows) {
    // v6.9（B）：**消息一旦落库即视为"已投递"**——内容恒在库，对端必能经"回合起始未读注入"读到。
    //   HTTP 唤醒改为"尽力而为、不阻塞"：不再 `await deliver()`（对 /api/chat 它是 SSE，阻塞到对端整个回合结束，最长 300s），
    //   改为异步发起一次即返回，随即标记 delivered=1（不再重投）。对端忙/卡死时不再反复重投 → 根治 ping-pong。
    //   注：不设"短超时 destroy"——客户端主动断开会触发对端 `req.on('close')→stopRun`，反而掐断对端回合。
    const att = (Number(m.attempts) || 0) + 1;
    try {
      Promise.resolve().then(() => deliver(m.to_id, m.content, m.to_session_id || null, true)).catch(() => { });
      db.prepare('UPDATE agent_messages SET delivered=1, attempts=? WHERE id=?').run(att, m.id);
      ok++;
    } catch { fail++; }
  }
  void maxAtt;   // v6.9（B）：落库即已投递，不再有"重试至死信"路径
  if (rows.length) console.log(`[mailbox] redeliver: scanned=${rows.length} ok=${ok} fail=${fail}`);
  return { scanned: rows.length, redelivered: ok, failed: fail };
}

/** 清理某会话相关的正/反向映射（纯 SQL，绝不删对端实例的会话文件）。返回删除行数。 */
function unlinkBySession(sessionId) {
  if (!db || !sessionId) return 0;
  const id = String(sessionId);
  try { return db.prepare('DELETE FROM session_links WHERE main_session_id=? OR peer_session_id=?').run(id, id).changes || 0; }
  catch { return 0; }
}

/** 对端懒创建会话：POST <base>/api/sessions → 返回 sessionId。 */
/** 可读角色短名（用于信箱会话标题：main/程序员/美工/文案/测试/研究员）。 */
const ROLE_SHORT = { main: '主我', programmer: '程序员', designer: '美工', writer: '文案', tester: '测试', researcher: '研究员' };
function shortRole(role) {
  if (!role) return '';
  const a = getAgent(role);
  const nm = (a && a.name) ? String(a.name).replace(/^雷影·|^雷仔·/, '') : '';
  return ROLE_SHORT[role] || nm || String(role);
}
/** 会话标题用全名：main → 主我；雷影 → 雷影·X（已带前缀则不重复）。 */
function fullRole(role) {
  if (!role) return '';
  if (String(role) === 'main') return '主我';
  const a = getAgent(role);
  const nm = (a && a.name) ? String(a.name) : '';
  if (/^雷影[·.]|^雷仔[·.]/.test(nm)) return nm;
  return '雷影·' + (shortRole(role) || String(role));
}
/** 取一条待投递消息 content 的前若干字作任务摘要（≤maxLen，压平空白）。 */
function msgSummary(msgId, maxLen = 20) {
  try {
    if (!db || !msgId) return '';
    const r = db.prepare('SELECT content FROM agent_messages WHERE id=?').get(String(msgId));
    const c = r && r.content ? String(r.content).replace(/\s+/g, ' ').trim() : '';
    return c.length > maxLen ? c.slice(0, maxLen) + '…' : c;
  } catch { return ''; }
}

async function createPeerSession(role, summary) {
  const a = getAgent(role);
  if (!a || !a.base_url) return null;
  try {
    const sum = String(summary || '').replace(/\s+/g, ' ').trim();
    const title = `信箱·${fullRole(selfRole())}↔${fullRole(role)}${sum ? ' · ' + sum : ''}`;
    const r = await httpPostJson(a.base_url, '/api/sessions', { title, project: 'mailbox' }, 15000);
    if (r.status >= 200 && r.status < 300) {
      try { return JSON.parse(r.body).id || null; } catch { return null; }
    }
  } catch { }
  return null;
}

/** 投递一条消息（唤醒对端）；wake=false 时只落库不 POST /api/chat（静默）。
 *  v6.7：连接类失败 → 先 ensureAgentUp(role) 惰性拉起对端，成功则重投一次。
 *  返回 {ok, status:'delivered'|'lazy-started'|'queued-peer-down'|'silent', error?, started?}。失败不抛（消息已落库）。 */
async function deliver(role, message, sessionId, wake = true) {
  const a = getAgent(role);
  if (!a) return { ok: false, status: 'queued-peer-down', error: `未注册的雷影角色：${role}` };
  if (!a.base_url) return { ok: false, status: 'queued-peer-down', error: `角色 ${role} 未配置 base_url` };
  if (wake === false) {
    // v5.3 静默：消息已落库，接收方下次回合经未读注入读到；不唤醒、不打断
    return { ok: true, status: 'silent', silent: true };
  }
  const post = () => httpPostJson(a.base_url, '/api/chat', { sessionId: sessionId || undefined, message }, 300000, { 'x-leizai-wake': '1' });
  try {
    const r = await post();
    const ok = r.status >= 200 && r.status < 300;
    if (ok) return { ok: true, status: 'delivered' };
    return { ok: false, status: 'queued-peer-down', httpStatus: r.status, error: `HTTP ${r.status}` };
  } catch (e) {
    // 连接类失败 → 惰性拉起对端，成功则重投一次
    let up = null;
    try { up = await ensureAgentUp(role); } catch { up = null; }
    if (up && up.ok) {
      try {
        const r2 = await post();
        const ok2 = r2.status >= 200 && r2.status < 300;
        if (ok2) return { ok: true, status: up.already ? 'delivered' : 'lazy-started', started: !!up.started };
        return { ok: false, status: 'queued-peer-down', httpStatus: r2.status, error: `HTTP ${r2.status}`, started: !!up.started };
      } catch (e2) {
        return { ok: false, status: 'queued-peer-down', error: e2.message, started: !!up.started };
      }
    }
    return { ok: false, status: 'queued-peer-down', error: e.message, lazyError: up && up.error };
  }
}

// ———————— v5.5：唤醒合并（debounce，仅对需要唤醒的消息生效）————————
// 同一目标在 mailboxCoalesceMs 窗口内的多条消息只触发一次 /api/chat 唤醒；
// 内容均已在库，对端回合起始经"未读注入"一次读全。窗口内进程重启→消息已在库，对端下次回合照读，不丢。
const _pendingWake = new Map();   // role -> { timer, sid, items:[{id,sid,content}] }

function scheduleWake(role, sid, id, content, overrideMs) {
  const c = cfg();
  const win = Number(c.mailboxCoalesceMs);
  let ms = Number.isFinite(win) && win >= 0 ? win : 800;
  if (Number.isFinite(overrideMs) && overrideMs >= 0) ms = Math.min(ms, overrideMs);   // v6阶段2：high 缩短窗口
  if (ms === 0) { return flushWake(role, [{ id, sid, content }]); }   // 禁用合并 → 立即投递（旧行为）
  let e = _pendingWake.get(role);
  if (!e) { e = { timer: null, sid: null, items: [] }; _pendingWake.set(role, e); }
  e.items.push({ id, sid, content });
  if (sid) e.sid = sid;
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => { flushWake(role); }, ms);
  try { if (e.timer.unref) e.timer.unref(); } catch { }   // 不阻止进程退出
}

/** @param {Array} direct 传入时立即投递这批(禁用合并用)，否则取该 role 的待发队列 */
async function flushWake(role, direct) {
  let items;
  if (direct) { items = direct; }
  else {
    const e = _pendingWake.get(role);
    if (!e) return;
    _pendingWake.delete(role);
    if (e.timer) clearTimeout(e.timer);
    items = e.items;
  }
  if (!items || !items.length) return;
  const last = items[items.length - 1];
  const sid = last.sid || null;
  const content = last.content;   // N=1 时即原内容 → 与旧版行为一致
  const r = await deliver(role, content, sid, true);
  for (const it of items) markDelivered(it.id, !!r.ok);
  if (!r.ok) console.error(`[mailbox] 投递 ${role} 失败：${r.error}（消息已落库，等对端上线读）`);
}

/**
 * 高层：发消息给某 role（落库 + 懒建会话映射 + 后台 HTTP 投递）。同步返回 {id, delivered?}。
 * @param {{fromRole,fromSessionId,toRole,content,topic,type,priority}} p
 */
/** v6.1：静默投递后，向目标实例发一个轻量事件通知（POST /api/mailbox/event，不唤醒 LLM）。
 *  仅用于"发往 main 的静默消息"→ 让主实例前端能实时上屏（带头像气泡）。
 *  失败不影响主流程（消息已在库，接收方仍可经未读注入读到）。 */
async function notifyInboundEvent(toRole, agent, info) {
  try {
    const full = String(info.content || '');
    const body = {
      to: toRole, from: info.fromRole, type: info.type || 'task',
      to_session_id: info.sessionId || null, msgId: info.id,
      preview: full.slice(0, 200), full, ts: info.ts || Date.now(),
      rev: (info.rev != null) ? info.rev : null, cid: info.cid || null,   // P2b-4：修订版本/关联 id（供接收方 abort 重注入）
      // v6.48（打回重修）：带上写侧唤醒意图 —— 否则接收方忙时走 /api/mailbox/event 排队，
      //   队列项无 wake_intent → 收尾 isActionableType 只能按 type 判 → reply 被判"回执类"→ 不唤醒（tester U1/U2 FAIL）。
      wake_intent: info.wakeIntent || null, notify_target: info.wakeIntent || null,
    };
    await httpPostJson(agent.base_url, '/api/mailbox/event', body, 8000);
    return true;
  } catch { return false; }
}

/** v6.7：投递前准备（同步）—— 解析对端会话映射 + 落库消息。返回 {error} 或 {toRole,agent,fromRole,fromSessionId,peerSessionId,id}。 */
function _sendPrep(p) {
  const toRole = String(p.toRole);
  const agent = getAgent(toRole);
  if (!agent) return { error: `未注册的雷影角色：${toRole}` };
  // 注销/停用防复活：拒绝投递（不返回成功），也绝不拉起
  if (agent.retired_at) return { error: `角色 ${toRole} 已注销（retired），拒绝投递` };
  if (Number(agent.enabled) === 0) return { error: `角色 ${toRole} 已停用（disabled），拒绝投递` };
  const fromRole = p.fromRole || selfRole() || 'unknown';
  const fromSessionId = p.fromSessionId || null;
  // 懒创建：仅当主会话第一次与该 role 通讯时
  let peerSessionId = null;
  if (fromSessionId) {
    const link = resolveSession(fromSessionId, toRole);
    if (link) peerSessionId = link.peer_session_id;
  }
  // v6.53（会话隔离泄漏修复）：无 link 时按 cid 从**原 task** 继承"对端会话"，杜绝 to_session_id=NULL。
  //   根因：回执/应答无会话归属时落 NULL，而接收侧未读注入允许 `to_session_id IS NULL` 被**任一会话**取走
  //   （见 fetchUnreadForSession）→ 其他会话的回执/[信箱续跑] 串进当前查看会话。
  //   真库实证：to main 的 13 条 NULL 消息中 8 条可经 cid→task.from_session_id 精确定位。
  if (!peerSessionId && p.correlationId) {
    try {
      const t = db.prepare(`SELECT from_session_id FROM agent_messages
          WHERE correlation_id=? AND type='task' AND from_id=? ORDER BY ts ASC LIMIT 1`)
        .get(String(p.correlationId), String(toRole));
      if (t && t.from_session_id) peerSessionId = String(t.from_session_id);   // 原派活会话 = 目标会话
    } catch { }
  }
  const id = sendMessage({
    from: fromRole, to: toRole, fromSessionId,
    toSessionId: peerSessionId,   // 对端会话已知则精确投递；未知则 NULL（对端任一会话可读）
    topic: p.topic, type: p.type, content: p.content, priority: p.priority,
    correlationId: p.correlationId, outcome: p.outcome, summary: p.summary,   // P2b-1：cid/result 契约字段透传
    rev: p.rev,   // P2b-4：版本号透传（同 cid 多版本修订）
    // P2b-8：结构化头/deadline/父任务透传（此前仅内部 sendMessage 层能设 → GAP-1/GAP-3 入口不通）
    meta: p.meta, deadline: p.deadline, parentId: p.parentId,
  });
  const meta = takeSendMeta(id) || {};
  return { toRole, agent, fromRole, fromSessionId, peerSessionId, id,
    cid: (String(p.type || 'task') === 'task') ? String(p.correlationId || id) : (p.correlationId ? String(p.correlationId) : null),
    rev: meta.rev != null ? meta.rev : null, isRevision: !!meta.isRevision, versionIgnored: !!meta.versionIgnored,
    wakeIntent: meta.wakeIntent || null };   // v6.48：把写侧唤醒意图透传给 _dispatch（供忙时路径同源判定）
}

/** v6.7：需要唤醒对端时确保其在线（不通则惰性拉起）；开关关闭时仅探活不拉起。返回 {ok,already?|started?,error?}。 */
async function _ensurePeerReady(agent, toRole) {
  const c = cfg();
  if (!agent || !agent.base_url) return { ok: false, error: `角色 ${toRole} 未配置 base_url` };
  if (c.mailboxLazyStart === false) {
    const alive = await probeUp(agent.base_url, 2000);
    return alive ? { ok: true, already: true } : { ok: false, error: '对端未启动（mailboxLazyStart=false，按需拉起已关闭）' };
  }
  return ensureAgentUp(toRole);
}

/** v6.7：异步派发（真正投递）。返回 {status,wokePeer,started?,error?}；status ∈ delivered|lazy-started|queued-peer-down。
 *  说明：静默/调度等分支沿用旧逻辑；唤醒分支先确保对端在线（惰性拉起），状态按"对端在线/由本进程拉起"如实上报。 */
/** 唤醒盲区根治：静默投递是否向目标实例发事件通知。
 *  旧逻辑仅 targetIsMain 才通知（发往雷影的静默 reply/ack/notify 落库后无唤醒事件 → 可永久静默）。
 *  新逻辑：只要前端上屏开关与 mailboxSilentNotify 均开，**任意目标**都通知（目标实例空闲即唤醒）。 */
function shouldNotifySilentDelivery(p) {
  try {
    const c = (p && p.cfg) || cfg();
    if (c.mailboxShowInbound === false) return false;
    if (c.mailboxSilentNotify === false) return false;
    return true;
  } catch { return false; }
}

/** v6.53-out：主我**出站**派活本地广播（涟漪流/气泡）。仅 selfRole()==='main' 生效
 *  （雷影→main 已有接收侧 /api/mailbox/event 广播，主我若再广播会重复）。
 *  通道：_hooks.emit('mailbox-message') → runtime.emit → server.broadcast（落盘+SSE）。
 *  纯 SSE：**绝不调用 wakeMailbox/runChat**，不触发任何唤醒。开关 config.mailboxShowOutbound（默认 true）。 */
function _echoOutbound(toRole, fromSessionId, id, p) {
  try {
    if (String(selfRole() || '') !== 'main') return;
    if (cfg().mailboxShowOutbound === false) return;
    if (typeof _hooks.emit !== 'function') return;
    const msg = getMessage(id) || {};
    const full = String(msg.content != null ? msg.content : ((p && p.content) || ''));
    _hooks.emit('mailbox-message', {
      sessionId: fromSessionId || null,
      from: selfRole(), to: toRole,
      type: (p && p.type) || 'task',
      msgId: id,
      preview: full.slice(0, 200), full,
      ts: msg.ts || Date.now(),
      outbound: true,
    });
  } catch { }
}
async function _dispatch(p, prep) {
  const { toRole, agent, id, fromRole, fromSessionId, peerSessionId } = prep;
  const c = cfg();
  const silentTypes = Array.isArray(c.mailboxSilentTypes) ? c.mailboxSilentTypes : ['reply'];
  const targetIsMain = !!(agent && agent.is_main);
  const dispEnabled = targetIsMain && c.mailboxDispatcherForMain !== false;
  const silentByType = c.mailboxSilentReply !== false && silentTypes.includes(String(p.type || 'task'));
  const silentByTarget = c.mailboxSilentForMain !== false && targetIsMain;
  // v6阶段2：priority 分级唤醒（urgent 突破静默立即唤醒；high 缩短合并窗口）。
  //   ★防回环（硬约束）：自动回执一律不传 priority → sendMessage 默认 'normal'。
  const priorityOn = c.mailboxPriorityWake !== false;
  const prio = String(p.priority || 'normal').toLowerCase();
  const isUrgent = priorityOn && prio === 'urgent';
  const isHigh = priorityOn && prio === 'high';
  const silent = (silentByType || silentByTarget) && !isUrgent;

  let sid = peerSessionId;
  const willWakePeer = !dispEnabled && !silent;
  const needPeerUp = dispEnabled || !silent;   // 需要唤醒（含调度会话投递）才拉起；静默分支绝不拉起（防惊群）

  // —— v6.7：按需拉起对端（惰性启动）——
  let up = { ok: true, already: true, skipped: true };
  if (needPeerUp) {
    try { up = await _ensurePeerReady(agent, toRole); }
    catch (e) { up = { ok: false, error: e.message }; }
  }

  // ★A/B：仅"真正唤醒对端会话"的分支才可能创建对端会话；静默/调度分支绝不创建（杜绝 0 消息空会话）。
  if (willWakePeer && fromSessionId && up.ok) {
    // B1：发起会话在本实例已不存在（已删/测试会话）→ 跳过创建，防孤儿
    let fromAlive = true;
    try { if (typeof _hooks.sessionExists === 'function') fromAlive = _hooks.sessionExists(fromSessionId) !== false; } catch { }
    if (!fromAlive) { sid = null; }
    else {
      // B2：link 指向的对端会话若已不存在 → 清映射并重建（存在/未知一律复用，绝不误建）
      if (sid) {
        const st = await peerSessionAlive(toRole, sid);
        if (st === 'gone') { try { unlinkBySession(fromSessionId); } catch { } sid = null; }
      }
      if (!sid) sid = await ensurePeerSession(fromSessionId, toRole, agent.base_url, id);
    }
  }
  // v5.3.1：无论命中还是懒建，只要 sid 已知就确保反向映射存在（幂等）。
  if (sid && fromSessionId && fromRole) {
    linkSession(sid, fromRole, fromSessionId, (getAgent(fromRole) || {}).base_url);
  }
  // v5.7：发给主实例的消息 → 投递唤醒"调度会话"（独立队列）
  if (dispEnabled) {
    const disp = getDispatcher(toRole);
    if (disp) {
      const r = await deliver(toRole, p.content, disp, true);
      markDelivered(id, !!r.ok);
      if (!r.ok) console.error(`[mailbox] 投递调度会话(${toRole}) 失败：${r.error}（消息已落库）`);
      return { status: r.ok ? 'delivered' : 'queued-peer-down', wokePeer: !!r.ok, error: r.error };
    }
    markDelivered(id, true);   // 无调度会话 → 回退 v5.6 静默
    _echoOutbound(toRole, fromSessionId, id, p);
    return { status: 'delivered', wokePeer: false };
  }
  // v5.6 回退路径 —— 静默分支（绝不创建对端会话、绝不拉起对端）
  if (silent) {
    markDelivered(id, true);                         // 静默：已落库即视为投递完成
    // 唤醒盲区根治：静默投递也必须通知目标实例（不再限于 main）——否则发往雷影的 reply/ack/notify
    //   落库后无任何唤醒事件，若该会话此后无新回合 → 永久静默。目标实例 /api/mailbox/event 仅在空闲时
    //   唤醒（忙则排队延迟补标）；防回环由 runtime 保证（reply 类入站不自动回执）。
    if (shouldNotifySilentDelivery({ targetIsMain }) && agent && agent.base_url) {
      const msg = getMessage(id) || {};
      await notifyInboundEvent(toRole, agent, {
        id, fromRole, type: p.type || 'task', sessionId: sid,
        content: p.content, ts: msg.ts || Date.now(), rev: prep.rev, cid: prep.cid, wakeIntent: prep.wakeIntent,
      });
    }
    _echoOutbound(toRole, fromSessionId, id, p);
    return { status: 'delivered', wokePeer: false };
  }
  // —— 唤醒分支：状态按"对端是否在线 / 是否由本进程拉起"如实上报 ——
  const status = up.ok ? ((up.already || up.skipped) ? 'delivered' : 'lazy-started') : 'queued-peer-down';
  // P2b-4 T1：修订（rev>1）——额外向对端投递 mailbox/event（携带 rev/cid），使其忙时 abort 当前回合并以最新版重注入。
  if (prep.isRevision && agent && agent.base_url) {
    try {
      const msg = getMessage(id) || {};
      await notifyInboundEvent(toRole, agent, { id, fromRole, type: p.type || 'task', sessionId: sid, content: p.content, ts: msg.ts || Date.now(), rev: prep.rev, cid: prep.cid, wakeIntent: prep.wakeIntent });
    } catch { }
  }
  if (isUrgent) {
    Promise.resolve(flushWake(toRole, [{ id, sid, content: p.content }])).catch(() => { });   // urgent：立即投递（不阻塞至整个对端回合）
  } else if (isHigh) {
    scheduleWake(toRole, sid, id, p.content, highCoalesceMs());   // high：缩短合并窗口
  } else {
    scheduleWake(toRole, sid, id, p.content);        // 合并窗口内一次唤醒
  }
  if (up.ok) _echoOutbound(toRole, fromSessionId, id, p);
  return { status, wokePeer: !!up.ok, started: !!up.started, error: up.ok ? undefined : up.error };
}

/**
 * 高层：发消息给某 role（落库 + 懒建会话映射 + 投递）。
 * - 同步返回 {ok,id,role,status,wokePeer}（status 初值 'queued'）；旧调用方只读 ok/id/role，不受影响。
 * - **该返回对象同时是 thenable**：`await sendToRole(p)` 会等到真实投递结果（status=delivered|lazy-started|queued-peer-down）。
 * @param {{fromRole,fromSessionId,toRole,content,topic,type,priority}} p
 */
function sendToRole(p) {
  const prep = _sendPrep(p);
  if (prep.error) {
    const fail = { ok: false, error: prep.error, status: 'queued-peer-down', wokePeer: false };
    const fsnap = { ok: false, error: prep.error, status: 'queued-peer-down', wokePeer: false };
    fail.then = (onF) => Promise.resolve(fsnap).then(onF);
    return fail;
  }
  const result = { ok: true, id: prep.id, cid: prep.cid, role: prep.toRole, status: 'queued', wokePeer: false };
  // ★关键：job 必须解析为**普通对象**，绝不能解析为 result（thenable）本身——
  //   否则 Promise 解析会自我同化（then 递归调用自己）形成死循环，await 永不返回。
  const snapshot = () => { const o = { ok: result.ok, id: result.id, cid: result.cid, role: result.role, status: result.status, wokePeer: !!result.wokePeer }; if (result.started) o.started = true; if (result.error) o.error = result.error; return o; };
  const job = _dispatch(p, prep)
    .then((r) => {
      result.status = r.status; result.wokePeer = !!r.wokePeer; result.started = !!r.started;
      if (r.error) result.error = r.error;
      return snapshot();
    })
    .catch((e) => { result.status = 'queued-peer-down'; result.error = e.message; return snapshot(); });
  result.then = (onFulfilled, onRejected) => job.then(onFulfilled, onRejected);
  return result;
}

/** v5.7：定向静默投递一条 notify 到指定会话（只落库不唤醒）。接收方=本实例主 role。 */
function notifySession(sessionId, content, fromRole) {
  if (!db) return null;
  const me = fromRole || selfRole() || 'main';
  return sendMessage({ from: me, to: me, fromSessionId: null, toSessionId: sessionId || null, type: 'notify', content: String(content) });
}

module.exports = {
  init, ensureSchema, enabled, available, selfRole, dbPath,
  registerAgent, getAgent, listAgents, touchLastSeen, retireAgent, reviveAgent,
  getDispatcher, setDispatcher, setAgentBusy, setBusy, clearBusy, touchAgentBusy, computeBusy, shouldNotifySilentDelivery, wakeDecision,
  markCidWoke, cidWoke, listNotWokeInbound, hasNotWokeInbound,   // v6.47：接收侧真起回合记位 + 未起回合入站扫描（唤醒丢失兜底）
  listStaleSilentInbound, markStaleSilentNotified,   // v6.53：知情类回执空闲兜底唤醒（reply/ack/notify 漏收根治）

  sendMessage, fetchUnread, fetchUnreadForSession, fetchInboundByIds, countUnread, markRead, markProcessing, markReplied, markRepliedIfUnreplied, reconcileInterruptedInbound, markDelivered, markAgedNonActionRead, sweepReadInfoConverge, sweepSilentRead, classify,   // v6.50：判据单源 + 静默收口
  listPending, listPendingForSession, getMessage, hasReplySince,
  linkSession, resolveSession, listLinks, linksWithStatus,
  createPeerSession, deliver, sendToRole, scheduleWake, flushWake,
  ensureAgentUp, probeUp,
  peerSessionAlive, unlinkBySession,
  notifySession, sweepStale, sweepExpired, sweepAwaitingClose, sweepRetention, listQueue, retry, redeliverPending, reviveAgents,
  shouldSend, listFlow, alertLogPath, setHooks, closeTaskByCid,
  takeSendMeta, cancelCid, isCidCancelled, isCidTerminal, cidState,   // P2b-4：版本/撤回
  advance, statusToState, stateOf, STATE_TERMINAL, verifyStateConsistency, sweepConvergeLegacy, reconcileStateStatus,   // P1：消息生命周期状态机
  pendingByMessage, notifyTargetOf, verifyWakeSplitConsistency,   // P2：wake_intent 拆列（notify_target / is_pending）
};
