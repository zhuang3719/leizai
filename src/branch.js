'use strict';
// 雷仔 · 世界树「支干」事件库（P0 · 完全态独立事件库）
//
// 设计（对齐 ADR-0004 / 世界树记忆架构_定稿v1 / 世代交接_设计v6 §4.1·§12）：
//  - 支干 = 独立 SQLite `branch.db`（每实例一份；默认 <dataDir>/branch.db）；"轮为骨、事件为肉"。
//  - 每轮写一条 `turn` 骨架（一行摘要），事件（note/todo/todo-done/prefix/prefix-done/decision/fruit）
//    按需挂在同一 turn_id 上。
//  - 双写、附加式：**不改动**现有账本(_progress.md)/记忆/归档/交接的行为——纯新增的第二落点。
//  - 库不可用 / 写入异常 → 静默跳过、优雅回退（绝不影响主流程）。
//  - 开关：config.branchEnabled（默认 true）；可用环境变量 LEIZAI_BRANCH_DB 或 init({dir}) 隔离测试。
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const DB_FILE = 'branch.db';
// 事件 kind 枚举（与定稿 v1 §3 / 任务书 T-A 一致）
const KINDS = ['turn', 'turn-ring', 'goal', 'note', 'todo', 'todo-done', 'prefix', 'prefix-done', 'decision', 'fruit', 'detail'];

function _normCore(s) {
  s = s.replace(/(?:19|20)\d{2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}/g, '');   // 日期戳
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '');                        // 时间戳
  s = s.replace(/[:：、，。；;（）()\[\]{}·\-—_～~!！?？'"“”‘’]/g, '');       // 常见标点（保 § 等实质符号）
  return s.replace(/\s+/g, '');
}
function _stripDoneBox(s) { return s.replace(/^[-*]?\s*\[\s*[xX✓✔\s]*\]\s*/, ''); }

/** 待补前缀（PREFIX）归一化指纹：**仅去格式化差异**用于比较，绝不改 payload 原文存储。
 *  ⚠️ **保留方括号内的实质文字**（不整块删 `[标签]`）——否则不同版本会误判同。
 *  @returns {string} 归一化键（空 payload 返回 ''） */
function normPrefixKey(payload) {
  return _normCore(_stripDoneBox(String(payload == null ? '' : payload)));
}
/** v6.38（P3）：待办（TODO）归一化键——治"措辞漂移导致勾销不收缩"。
 *  与 normPrefixKey 同源同口径（仅去格式化差异：日期/时间/标点/空白/首部 [x] 复选框），**绝不改 payload 原文存储**。
 *  空 payload → ''（调用方需自行兜底用原文）。 */
function normTodoKey(payload) {
  return _normCore(_stripDoneBox(String(payload == null ? '' : payload)));
}
/** 主体键（B 级近似比较用）：在 normPrefixKey 基础上**再剥连续前导 `[标签]`**，以便
 *  "同事项不同版本标签"（如 交接后做 vs 修正定稿）以**正文前 N 字**判定。**仅用于比较**，不改原文。 */
function normBodyKey(payload) {
  let s = _stripDoneBox(String(payload == null ? '' : payload));
  // 剥连续前导 `[标签]`（兼容行首可选的 `- ` / `* ` 项目符号；否则 `- [标签] 正文` 剥不掉）
  s = s.replace(/^\s*[-*]?\s*(?:\[[^\]]*\]\s*)+/, '');
  return _normCore(s);
}
/** 供 B 级近似比较（findSimilarOpenPrefix）使用的"正文键"：剥首部 [标签] 后归一化。
 *  语义 = normBodyKey；单列一名使调用处意图清晰。**仅用于比较**，不改 payload 原文。 */
function normPrefixBodyKey(payload) { return normBodyKey(payload); }

// —— A3（2026-09-25）：枝键别名归一（**仅读取侧**，绝不改库）——
//   同主题不同写法在展示层合并为规范键，治"枝键漂移"。
const TOPIC_ALIASES = {
  '会话树能力测试与修复': '会话树与交接',
  '通讯未读口径修复': '通讯流程可视化',
};
/** 把枝键规范化为展示/合并用键（无别名则原样返回；空值返回空串）。 */
function normalizeTopicKey(k) {
  const s = String(k == null ? '' : k).trim();
  if (!s) return s;
  return TOPIC_ALIASES[s] || s;
}

let hasRefCols = true;   // v4-4：ref/corr_id 列是否可用（迁移失败时 append 退化，保证不中断写入）
let hasNewCols = true;   // 批A（A1）：turn_no/sub_seq/origin/topic_key 列是否可用（旧库迁移失败 → append/fold 退化，保证不中断）
let hasTopicSource = true;   // A1''（2026-09-29）：topic_source 列是否可用（auto/manual 区分；迁移失败 → 重整退化为不动，保证不中断）
let BRANCH_DIR = null;   // 惰性解析：优先 env，其次 dataDir（每次可被 init 重定向）
let db = null;
let mode = 'off';        // 'sqlite' | 'off'
let inited = false;

function resolveDir(opts = {}) {
  if (opts && opts.dir) return opts.dir;
  if (process.env.LEIZAI_BRANCH_DB) return path.dirname(process.env.LEIZAI_BRANCH_DB);
  return DATA_DIR;
}
function resolveFile(opts = {}) {
  if (opts && opts.file) return opts.file;
  if (process.env.LEIZAI_BRANCH_DB) return process.env.LEIZAI_BRANCH_DB;
  return path.join(resolveDir(opts), DB_FILE);
}
function dbPath() {
  if (process.env.LEIZAI_BRANCH_DB) return process.env.LEIZAI_BRANCH_DB;
  if (!BRANCH_DIR) BRANCH_DIR = DATA_DIR;
  return path.join(BRANCH_DIR, DB_FILE);
}

/** 开关：config.branchEnabled !== false（默认 true）。异常一律视为开（不因配置读取失败而丢支干）。 */
function enabled() {
  try {
    const v = require('./config').load().branchEnabled;
    return v !== false;
  } catch { return true; }
}

/** 初始化存储层（可重复调用以重定向路径，供测试隔离）。@returns 生效模式 'sqlite'|'off' */
function init(opts = {}) {
  if (!enabled() && !(opts && opts.force)) { mode = 'off'; inited = true; return mode; }
  const file = resolveFile(opts);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { mode = 'off'; inited = true; return mode; }
  try {
    const sqlite = require('node:sqlite');
    if (db) { try { db.close(); } catch { } }
    db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA synchronous=NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS branch_event (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        gen         INTEGER NOT NULL DEFAULT 0,
        turn_id     TEXT    NOT NULL DEFAULT '',
        seq         INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        payload     TEXT    NOT NULL DEFAULT '',
        ts          INTEGER NOT NULL,
        ref         TEXT    NOT NULL DEFAULT '',
        corr_id     TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_be_sid_ts   ON branch_event(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_be_sid_kind ON branch_event(session_id, kind);
    `);
    // v4-4 T-A：血脉列幂等迁移（旧库自动补列；已存在则跳过）
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(branch_event)').all().map((r) => String(r.name)));
      if (!cols.has('ref')) db.exec("ALTER TABLE branch_event ADD COLUMN ref TEXT NOT NULL DEFAULT ''");
      if (!cols.has('corr_id')) db.exec("ALTER TABLE branch_event ADD COLUMN corr_id TEXT NOT NULL DEFAULT ''");
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_ref ON branch_event(session_id, ref);');
    } catch { }
    // 批A（A1）：会话树主轴/分枝列 **附加式·幂等** 迁移（旧库自动补列；已存在则跳过；旧读不含新列不报错）
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(branch_event)').all().map((r) => String(r.name)));
      if (!cols.has('turn_no')) db.exec('ALTER TABLE branch_event ADD COLUMN turn_no INTEGER');
      if (!cols.has('sub_seq')) db.exec('ALTER TABLE branch_event ADD COLUMN sub_seq INTEGER');
      if (!cols.has('origin')) db.exec('ALTER TABLE branch_event ADD COLUMN origin TEXT');
      if (!cols.has('topic_key')) db.exec('ALTER TABLE branch_event ADD COLUMN topic_key TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_turnno ON branch_event(session_id, turn_no);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_topic  ON branch_event(session_id, topic_key);');
      // 幂等兜底：同会话同 turn_id 的 turn 节点至多 1 条（partial unique）。旧库若已有重复(理论上不会) → 建索引失败被 catch，写路径 hasEvent 查重仍生效。
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_be_turn ON branch_event(session_id, turn_id) WHERE kind='turn';");
    } catch { }
    // A1''（2026-09-29）：自动归枝「来源」列 + 重整元数据/回滚表（附加式·幂等）。
    //   topic_source: 'auto'=自动归枝可重整；'manual'=人工/显式指定，重整绝不覆盖。
    //   存量迁移：已有 topic 的行一律回填 'manual'（保守，不被重整重排）；无 topic 的行视为 'auto'（可被重整补填）。
    try {
      const colsTs = new Set(db.prepare('PRAGMA table_info(branch_event)').all().map((r) => String(r.name)));
      if (!colsTs.has('topic_source')) {
        db.exec("ALTER TABLE branch_event ADD COLUMN topic_source TEXT DEFAULT 'manual'");
        db.exec("UPDATE branch_event SET topic_source='manual' WHERE topic_key IS NOT NULL AND topic_key<>''");
        db.exec("UPDATE branch_event SET topic_source='auto' WHERE topic_key IS NULL OR topic_key=''");
      }
      colsTs.clear();
      for (const r of db.prepare('PRAGMA table_info(branch_event)').all()) colsTs.add(String(r.name));
      hasTopicSource = colsTs.has('topic_source');
      db.exec('CREATE TABLE IF NOT EXISTS branch_meta (k TEXT PRIMARY KEY, v TEXT)');
      db.exec(`CREATE TABLE IF NOT EXISTS branch_reflow_undo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, gen INTEGER NOT NULL,
        turn_no INTEGER, old_topic_key TEXT, ts INTEGER
      );`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_reflow_undo_sg ON branch_reflow_undo(session_id, gen);');
    } catch { hasTopicSource = false; }
    // 迁移结果落旗：若补列失败（极端/旧 SQLite），append 退化为老式 INSERT，保证支干写入不中断
    try {
      const cols2 = new Set(db.prepare('PRAGMA table_info(branch_event)').all().map((r) => String(r.name)));
      hasRefCols = cols2.has('ref') && cols2.has('corr_id');
      hasNewCols = cols2.has('turn_no') && cols2.has('sub_seq') && cols2.has('origin') && cols2.has('topic_key');
      hasTopicSource = cols2.has('topic_source');
    } catch { hasRefCols = false; hasNewCols = false; hasTopicSource = false; }
    mode = 'sqlite';
  } catch {
    db = null; mode = 'off';
  }
  inited = true;
  return mode;
}

function ensureInit() {
  if (!inited) init();
}

function close() {
  if (db) { try { db.close(); } catch { } db = null; }
  inited = false;
}

function nextSeq(sessionId) {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM branch_event WHERE session_id = ?').get(String(sessionId));
  return r ? r.s : 1;
}

/**
 * 追加一条支干事件。失败/关闭 → 静默返回 null（优雅回退，绝不影响主流程）。
 * @param {object} e { sessionId, gen?, turnId?, kind, payload, ts? }
 * @returns {number|null} 写入的 seq，或 null（未写）
 */
function append(e) {
  try {
    if (!enabled()) return null;
    ensureInit();
    if (mode !== 'sqlite' || !db) return null;
    if (!e || !e.sessionId || !e.kind) return null;
    const sid = String(e.sessionId);
    const seq = nextSeq(sid);
    const ts = Number(e.ts) || Date.now();
    const gen = Number.isFinite(Number(e.gen)) ? Number(e.gen) : 0;
    // 注意：不缓存 prepared statement 跨大分配使用（node:sqlite 长命 StatementSync 会被 GC 提前 finalize）。
    if (hasRefCols && hasNewCols) {
      db.prepare('INSERT INTO branch_event (session_id, gen, turn_id, seq, kind, payload, ts, ref, corr_id, turn_no, sub_seq, origin, topic_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(sid, gen, String(e.turnId || ''), seq, String(e.kind), String(e.payload == null ? '' : e.payload), ts, String(e.ref || ''), String(e.corrId || ''),
          e.turnNo == null ? null : Number(e.turnNo), e.subSeq == null ? null : Number(e.subSeq),
          e.origin == null ? null : String(e.origin), e.topicKey == null ? null : String(e.topicKey));
    } else if (hasNewCols) {
      db.prepare('INSERT INTO branch_event (session_id, gen, turn_id, seq, kind, payload, ts, turn_no, sub_seq, origin, topic_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(sid, gen, String(e.turnId || ''), seq, String(e.kind), String(e.payload == null ? '' : e.payload), ts,
          e.turnNo == null ? null : Number(e.turnNo), e.subSeq == null ? null : Number(e.subSeq),
          e.origin == null ? null : String(e.origin), e.topicKey == null ? null : String(e.topicKey));
    } else if (hasRefCols) {
      db.prepare('INSERT INTO branch_event (session_id, gen, turn_id, seq, kind, payload, ts, ref, corr_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sid, gen, String(e.turnId || ''), seq, String(e.kind), String(e.payload == null ? '' : e.payload), ts, String(e.ref || ''), String(e.corrId || ''));
    } else {
      db.prepare('INSERT INTO branch_event (session_id, gen, turn_id, seq, kind, payload, ts) VALUES (?,?,?,?,?,?,?)')
        .run(sid, gen, String(e.turnId || ''), seq, String(e.kind), String(e.payload == null ? '' : e.payload), ts);
    }
    return seq;
  } catch { return null; }
}

/** 写一轮骨架（kind=turn）。aborted=true 表示失败/中断轮。 */
function writeTurn(sessionId, gen, summary, turnId, aborted = false) {
  const payload = aborted ? JSON.stringify({ summary: String(summary || ''), aborted: true }) : String(summary || '');
  return append({ sessionId, gen, turnId, kind: 'turn', payload });
}

/** 批A（A3）：轮末统一 flush —— 把本轮 turn 骨架与其 turn_id 上的事件统一落位（单事务）。
 *  - user 轮：turn_no = 本会话 MAX(turn_no)+1，写 1 条 turn；本轮事件挂同 turn_no（sub_seq=0）。
 *  - 非 user 轮（mailbox/heartbeat/timer/resume）：不自增 turn_no，挂上一 user 轮 turn_no，sub_seq 递增；不写 turn 行。
 *  - 幂等：同 (session_id,turn_id) 已有 turn 行 → 复用其 turn_no，不重复写（UNIQUE uq_be_turn 兜底）。
 *  - 轮内再交接不新增/不跳号（调用方每回合仅调一次保证）。
 *  @param {object} o {sessionId, turnId, gen, summary, origin, ts, aborted, topicKey, detail}
 *  @returns {{ok:boolean, turnNo:number|null, origin:string, isUser:boolean, error?:string}} */
function flushTurn(o = {}) {
  const origin = String(o.origin || 'user');
  const isUser = origin === 'user';
  const ret = { ok: false, turnNo: null, origin, isUser };
  try {
    if (!enabled()) return ret;
    ensureInit();
    if (mode !== 'sqlite' || !db) return ret;
    const sid = String(o.sessionId || '');
    const tid = String(o.turnId || '');
    if (!sid || !tid) return ret;
    const gen = Number.isFinite(Number(o.gen)) ? Number(o.gen) : 0;
    const ts = Number(o.ts) || Date.now();
    const summary = String(o.summary || '').slice(0, 160);
    const aborted = !!o.aborted;
    const detail = (o.detail == null ? '' : String(o.detail)).slice(0, 4000);
    db.exec('BEGIN IMMEDIATE');
    try {
      let turnNo = null;
      if (hasNewCols) {
        const ex = db.prepare("SELECT turn_no FROM branch_event WHERE session_id=? AND turn_id=? AND kind='turn' LIMIT 1").get(sid, tid);
        if (ex && ex.turn_no != null) turnNo = Number(ex.turn_no);
      }
      if (turnNo == null && isUser) {
        let mx = 0;
        if (hasNewCols) { const r = db.prepare("SELECT COALESCE(MAX(turn_no),0) AS m FROM branch_event WHERE session_id=? AND kind='turn'").get(sid); mx = Number(r && r.m) || 0; }
        turnNo = mx + 1;
        const payload = aborted ? JSON.stringify({ summary, aborted: true }) : summary;
        append({ sessionId: sid, gen, turnId: tid, kind: 'turn', payload, ts, turnNo, subSeq: 0, origin, topicKey: o.topicKey });
        // 批B（B1.1）：首代目标独立标记 kind='goal'（本会话仅一条，compact/fold 强制保留 → 不被折叠丢）。
        if (!aborted) {
          try {
            const hasGoal = db.prepare("SELECT 1 FROM branch_event WHERE session_id=? AND kind='goal' LIMIT 1").get(sid);
            if (!hasGoal) append({ sessionId: sid, gen, turnId: tid, kind: 'goal', payload: String(summary || '').slice(0, 300), ts, turnNo, subSeq: 0, origin });
          } catch { }
        }
      } else if (turnNo == null && !isUser && hasNewCols) {
        const r = db.prepare("SELECT MAX(turn_no) AS m FROM branch_event WHERE session_id=? AND kind='turn'").get(sid);
        turnNo = (r && r.m != null) ? Number(r.m) : null;
      }
      // topic 继承：turn 行在轮末才写，若本调用未显式给 topicKey，则沿用本轮事件已带上的 topic_key（log_progress topic 透传而来）。
      if (hasNewCols) {
        try {
          let tp = (o.topicKey == null ? null : String(o.topicKey));
          if (tp == null || tp === '') {
            const er = db.prepare("SELECT topic_key FROM branch_event WHERE session_id=? AND turn_id=? AND kind!='turn' AND topic_key IS NOT NULL LIMIT 1").get(sid, tid);
            tp = (er && er.topic_key != null) ? String(er.topic_key) : null;
          }
          if (tp != null && tp !== '') db.prepare("UPDATE branch_event SET topic_key=? WHERE session_id=? AND turn_id=? AND kind='turn' AND topic_key IS NULL").run(tp, sid, tid);
        } catch { }
      }
      if (detail) append({ sessionId: sid, gen, turnId: tid, kind: 'detail', payload: detail, ts, turnNo, subSeq: isUser ? 0 : null, origin });
      if (turnNo != null && hasNewCols) {
        let subSeq = 0;
        if (!isUser) {
          const r = db.prepare("SELECT COALESCE(MAX(sub_seq),0) AS m FROM branch_event WHERE session_id=? AND turn_no=? AND kind!='turn'").get(sid, turnNo);
          subSeq = (Number(r && r.m) || 0) + 1;
        }
        db.prepare("UPDATE branch_event SET turn_no=COALESCE(turn_no,?), origin=COALESCE(origin,?), sub_seq=COALESCE(sub_seq,?), topic_key=COALESCE(topic_key,?) WHERE session_id=? AND turn_id=? AND kind!='turn'").run(turnNo, origin, subSeq, (o.topicKey == null ? null : String(o.topicKey)), sid, tid);
      }
      db.exec('COMMIT');
      ret.ok = true; ret.turnNo = turnNo;
      return ret;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      ret.error = String((e && e.message) || e);
      return ret;
    }
  } catch (e) { ret.error = String((e && e.message) || e); return ret; }
}

/**
 * fold 查询：把事件流折叠为跨世代连续性素材。纯读、幂等、可重复调用无副作用。
 * @param {string} sessionId
 * @param {number} nearTurns 近 N 轮骨架（默认 8）
 * @returns {{openTodos:string[], pendingPfx:string[], turns:object[], gens:number[], counts:object}}
 */
function fold(sessionId, nearTurns = 8, ext = null) {
  const empty = { openTodos: [], openTodoMeta: [], pendingPfx: [], turns: [], gens: [], counts: {}, totalTurns: 0, earlier: { count: 0, genMin: null, genMax: null }, decisions: [], rings: [], openDispatches: [], goal: '' };
  try {
    // G1（2026-09-29）：ext = 外部实例库只读折叠（跨实例聚合用）——ext={db, hasNewCols} 时不碰本实例单例。
    const _db = (ext && ext.db) ? ext.db : db;
    const _newCols = ext ? !!ext.hasNewCols : hasNewCols;
    if (!ext) { ensureInit(); if (mode !== 'sqlite' || !db) return empty; }
    if (!_db) return empty;
    const sid = String(sessionId);
    const _sel = _newCols
      ? 'seq, gen, turn_id, kind, payload, ts, turn_no, sub_seq, origin, topic_key'
      : 'seq, gen, turn_id, kind, payload, ts';
    const rows = _db.prepare(`SELECT ${_sel} FROM branch_event WHERE session_id = ? ORDER BY seq ASC`).all(sid);
    if (!rows || !rows.length) return empty;

    const counts = {};
    // v6.38（P3）：todo 勾销改用**归一化键**匹配（对齐 prefix 口径），治"措辞漂移/标点差异 → 勾销不收缩"。
    //  P5：每条 open 记首见 seq/ts，供树/交接标注"已 X 天未更新"（**只标注，绝不自动删**）。
    const todoOpen = new Map();    // normTodoKey -> { payload, seq, ts }
    const todoDone = new Set();    // normTodoKey
    const pfxOpen = new Map();     // 归一化指纹 -> 首个 payload 原文（用于比较键；返回仍给原文）
    const pfxDone = new Set();     // 归一化指纹
    const gens = new Set();

    for (const r of rows) {
      counts[r.kind] = (counts[r.kind] || 0) + 1;
      if (Number.isFinite(Number(r.gen))) gens.add(Number(r.gen));
      const p = String(r.payload || '');
      if (r.kind === 'todo') { const k = normTodoKey(p) || p; if (k && !todoOpen.has(k)) todoOpen.set(k, { payload: p, seq: Number(r.seq) || 0, ts: Number(r.ts) || 0 }); }
      else if (r.kind === 'todo-done') { const k = normTodoKey(p) || p; if (k) todoDone.add(k); }
      else if (r.kind === 'prefix') { const k = normPrefixKey(p); if (k && !pfxOpen.has(k)) pfxOpen.set(k, p); }
      else if (r.kind === 'prefix-done') { const k = normPrefixKey(p); if (k) pfxDone.add(k); }
    }

    const _openEntries = [...todoOpen.entries()].filter(([k]) => !todoDone.has(k));
    const openTodos = _openEntries.map(([, v]) => v.payload);
    // P5：陈旧标注素材（首见 seq/ts + 天数）；供 tree / 交接文档对超期项标注"已 X 天未更新，请确认"。
    const _nowMs = Date.now();
    const openTodoMeta = _openEntries.map(([, v]) => ({
      payload: v.payload, firstSeenSeq: v.seq || null, firstSeenTs: v.ts || null,
      ageDays: v.ts ? Math.floor((_nowMs - v.ts) / 86400000) : null,
    }));
    const pendingPfx = [...pfxOpen.entries()].filter(([k]) => !pfxDone.has(k)).map(([, v]) => v);   // 归一化收缩：done 可勾掉"同事项不同措辞"的 open
    // v4-2（附加字段）：决定事件（供交接 fold 合成 KEY 决定区，有界）。
    // P2-prep：与 P0 修复后的账本 KEY 区口径对齐 —— **首部奠基(默认 4 条) + 尾部最新**，总 ≤40。
    //   行按 seq ASC（最旧在前），故首部 = seq 最小（奠基条目）、尾部 = seq 最大（最新条目）。
    const allDecisions = rows.filter((r) => r.kind === 'decision').map((r) => String(r.payload || '')).filter(Boolean);
    const DEC_TOTAL = 40, DEC_HEAD = 4;
    let decisions;
    if (allDecisions.length <= DEC_TOTAL) decisions = allDecisions;
    else decisions = [...allDecisions.slice(0, DEC_HEAD), ...allDecisions.slice(-(DEC_TOTAL - DEC_HEAD))];

    const turnRows = rows.filter((r) => r.kind === 'turn');
    // v4-1（附加字段，不改老语义）：非 turn 事件按 turn_id 归组，供交接「近期时间线」逐轮挂载。
    const evByTurn = new Map();
    for (const r of rows) {
      if (r.kind === 'turn') continue;
      const tid = String(r.turn_id || '');
      if (!tid) continue;
      if (!evByTurn.has(tid)) evByTurn.set(tid, []);
      evByTurn.get(tid).push({ kind: r.kind, payload: String(r.payload || ''), ts: r.ts });
    }
    const shown = turnRows.slice(-Math.max(1, Number(nearTurns) || 8));
    const turns = shown.map((r) => {
      let summary = r.payload, aborted = false;
      try { const o = JSON.parse(r.payload); if (o && typeof o === 'object') { summary = o.summary || ''; aborted = !!o.aborted; } } catch { }
      return { turnId: r.turn_id, gen: r.gen, summary: String(summary || ''), aborted, ts: r.ts, seq: r.seq, turnNo: r.turn_no == null ? null : Number(r.turn_no), subSeq: r.sub_seq == null ? null : Number(r.sub_seq), origin: r.origin == null ? null : String(r.origin), topicKey: r.topic_key == null ? null : normalizeTopicKey(String(r.topic_key)), events: evByTurn.get(String(r.turn_id || '')) || [] };
    });
    // 更早轮次（被截掉的）：仅给计数与世代范围，供"更早：第 X~Y 代"折叠行。
    const earlierRows = turnRows.slice(0, Math.max(0, turnRows.length - shown.length));
    let genMin = null, genMax = null;
    for (const r of earlierRows) {
      const g = Number(r.gen);
      if (!Number.isFinite(g)) continue;
      genMin = genMin == null ? g : Math.min(genMin, g);
      genMax = genMax == null ? g : Math.max(genMax, g);
    }

    // v4-3 T-B：年轮索引（按 gen 分组；近 20 代，有界；highlights ≤3 条轮摘要）。
    const sumOf = (r) => { try { const o = JSON.parse(r.payload); if (o && typeof o === 'object') return String(o.summary || ''); } catch { } return String(r.payload || ''); };
    const ringMap = new Map();
    for (const r of turnRows) {
      const g = Number.isFinite(Number(r.gen)) ? Number(r.gen) : 0;
      let ring = ringMap.get(g);
      if (!ring) { ring = { gen: g, turnCount: 0, firstTs: null, lastTs: null, highlights: [] }; ringMap.set(g, ring); }
      ring.turnCount++;
      const t = Number(r.ts) || 0;
      if (ring.firstTs == null || t < ring.firstTs) ring.firstTs = t;
      if (ring.lastTs == null || t > ring.lastTs) ring.lastTs = t;
      if (ring.highlights.length < 3) {
        const txt = sumOf(r).replace(/\s+/g, ' ').trim().slice(0, 60);
        if (txt) ring.highlights.push(txt);
      }
    }
    const rings = [...ringMap.values()].sort((a, b) => a.gen - b.gen).slice(-20);   // 有界：近 20 代

    // 批A（A4）：openDispatches —— 在途派单（复用 mailbox 实时查询，**不新增 branch 事件**）。
    //   G1：外部实例折叠（ext）时跳过——mailbox 是本实例自己的，他实例的在途派单不在此反映。
    let openDispatches = [];
    if (!ext) try {
      const mb = require('./mailbox');
      const role = (mb && mb.selfRole) ? mb.selfRole() : null;
      if (role && mb.listPendingForSession) {
        // v6.51：树视图=**只读**（可为任意会话），传 claim:false 不认领 NULL 归属行（防查看旧会话树时误吸消息）。
        openDispatches = (mb.listPendingForSession(role, sid, { claim: false }) || []).map((m) => ({ id: m.id, from: m.from_id, type: m.type, ts: m.ts, content: String(m.content || '').slice(0, 120) }));
      }
    } catch { }

    // 批B（B1.1）：首代目标（kind='goal'，最早一条）——供树版交接「原始目标」兜底源。
    let goal = '';
    try { const gr = rows.find((r) => r.kind === 'goal'); if (gr) goal = String(gr.payload || ''); } catch { }

    return { openTodos, openTodoMeta, pendingPfx, turns, gens: [...gens].sort((a, b) => a - b), counts, totalTurns: turnRows.length, earlier: { count: earlierRows.length, genMin, genMax }, decisions, rings, openDispatches, goal };
  } catch { return empty; }
}

/** v4-3 T-A：幂等判据——同 session + turn_id + kind + payload 的事件是否已存在。异常→false（不阻断写入）。 */
/** 查找"近似重复"（B 级）的未勾销待补前缀：**主体键（剥前导 [标签] 后正文）前 prefixLen 字相同但整体不同**。
 *  仅用于**告警**（保留人工判断权）——**绝不自动删除/合并**任何条目。
 *  @param {string} payload 待写入的原文
 *  @returns {string[]} 命中的既有 open 项原文 */
function findSimilarOpenPrefix(sessionId, payload, prefixLen = 16) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return [];
    const nk = normPrefixBodyKey(payload);
    if (!nk || nk.length < prefixLen) return [];
    const head = nk.slice(0, prefixLen);
    const sid = String(sessionId);
    const rows = db.prepare("SELECT kind, payload FROM branch_event WHERE session_id = ? AND kind IN ('prefix','prefix-done')").all(sid);
    const open = new Map(), done = new Set();
    for (const r of rows) {
      const bk = normPrefixBodyKey(r.payload);
      if (!bk) continue;
      if (r.kind === 'prefix-done') done.add(bk);
      else if (!open.has(bk)) open.set(bk, String(r.payload || ''));
    }
    const out = [];
    for (const [bk, raw] of open) {
      if (bk === nk) continue;            // A 级（完全相同）由 hasOpenPrefix 处理
      if (done.has(bk)) continue;
      if (bk.slice(0, prefixLen) === head) out.push(raw);
    }
    return out;
  } catch { return []; }
}

function hasEvent(sessionId, turnId, kind, payload) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return false;
    const sid = String(sessionId), tid = String(turnId || ''), k = String(kind || ''), pl = String(payload == null ? '' : payload);
    const row = db.prepare('SELECT 1 AS x FROM branch_event WHERE session_id = ? AND turn_id = ? AND kind = ? AND payload = ? LIMIT 1').get(sid, tid, k, pl);
    return !!(row && row.x);
  } catch { return false; }
}

/** 去掉"完成注解"后缀（如 "—— 已完成：xxx" / "— 完成：…" / " - done: …"）——**仅用于比较/解析**，不改存储原文。
 *  目的：让"原文 + 后缀说明"的勾销也能定位到原始 open 条目。 */
function _stripDoneAnnotation(s) {
  return String(s == null ? '' : s)
    .replace(/\s*[—\-–]{1,2}\s*(?:已完成|完成|已勾销|已勾除|已收口|done|finished)\s*[:：]?[\s\S]*$/i, '')
    .trim();
}

/** 查找"与该勾销内容对应的未勾销 open 前缀原文"——命中则以【open 原样 payload】写 prefix-done，
 *  保证 fold 严格匹配命中（治"勾销不收缩"根因）。找不到 → null（调用方回退现行为）。
 *  匹配次序：①去完成注解后归一化全等 ②去注解前归一化全等 ③正文键头部（≥prefixLen）近似。
 *  @returns {string|null} open 原文 */
function resolveOpenPrefixPayload(sessionId, payload, prefixLen = 16) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return null;
    const sid = String(sessionId);
    const rows = db.prepare("SELECT kind, payload FROM branch_event WHERE session_id = ? AND kind IN ('prefix','prefix-done')").all(sid);
    const open = new Map(), done = new Set();   // 键=normPrefixKey
    for (const r of rows) {
      const k = normPrefixKey(r.payload); if (!k) continue;
      if (r.kind === 'prefix-done') done.add(k);
      else if (!open.has(k)) open.set(k, String(r.payload || ''));
    }
    const cand = _stripDoneAnnotation(payload);
    for (const c of [cand, String(payload == null ? '' : payload)]) {
      const nk = normPrefixKey(c);
      if (nk && open.has(nk) && !done.has(nk)) return open.get(nk);
    }
    // B 级：正文键头部匹配（最小长度 ≥ prefixLen 守卫，防短串误配）
    const bk = normPrefixBodyKey(cand);
    if (bk && bk.length >= prefixLen) {
      const head = bk.slice(0, prefixLen);
      for (const [k, raw] of open) {
        if (done.has(k)) continue;
        const ob = normPrefixBodyKey(raw);
        if (ob.length >= prefixLen && ob.slice(0, prefixLen) === head) return raw;
      }
    }
    return null;
  } catch { return null; }
}

/** v6.38（P3）：查找"与该勾销内容对应的未勾销 open 待办原文"——**归一化键匹配**（对齐 prefix 口径），
 *  治"措辞漂移/标点差异 → 勾销不收缩"。次序：①去完成注解后归一化全等 ②去注解前归一化全等
 *  ③原文全等（向后兼容存量） ④正文键头部（≥prefixLen）近似。
 *  @returns {string|null} open 原文 */
function resolveOpenTodoPayload(sessionId, payload, prefixLen = 16) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return null;
    const sid = String(sessionId);
    const rows = db.prepare("SELECT kind, payload FROM branch_event WHERE session_id = ? AND kind IN ('todo','todo-done')").all(sid);
    const open = new Map(), done = new Set();   // 键=normTodoKey
    const rawOpen = new Set();                  // 原文全等兜底（存量兼容）
    for (const r of rows) {
      const p = String(r.payload || ''); if (!p) continue;
      const k = normTodoKey(p) || p;
      if (r.kind === 'todo-done') done.add(k);
      else { if (!open.has(k)) open.set(k, p); rawOpen.add(p); }
    }
    const cand = _stripDoneAnnotation(payload);
    for (const c of [cand, String(payload == null ? '' : payload)]) {
      if (!c) continue;
      const k = normTodoKey(c);
      if (k && open.has(k) && !done.has(k)) return open.get(k);
      if (rawOpen.has(c) && !done.has(normTodoKey(c) || c)) return c;   // 存量原文全等兜底
    }
    // B 级：正文键头部近似（最小长度 ≥ prefixLen 守卫，防短串误配）
    const bk = normBodyKey(cand);
    if (bk && bk.length >= prefixLen) {
      const head = bk.slice(0, prefixLen);
      for (const [k, raw] of open) {
        if (done.has(k)) continue;
        const ob = normBodyKey(raw);
        if (ob.length >= prefixLen && ob.slice(0, prefixLen) === head) return raw;
      }
    }
    return null;
  } catch { return null; }
}

/** 本会话是否已存在"未勾销的同类"待补前缀（按归一化指纹比较）——用于写路径幂等（防重复 append）。
 *  @returns {boolean} true=已存在同类 open（应跳过 append） */
function hasOpenPrefix(sessionId, normKey) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return false;
    if (!normKey) return false;
    const sid = String(sessionId);
    const rows = db.prepare("SELECT kind, payload FROM branch_event WHERE session_id = ? AND kind IN ('prefix','prefix-done')").all(sid);
    const open = new Set(), done = new Set();
    for (const r of rows) { const k = normPrefixKey(r.payload); if (!k) continue; if (r.kind === 'prefix-done') done.add(k); else open.add(k); }
    return open.has(normKey) && !done.has(normKey);
  } catch { return false; }
}

// ==================== v4-4 T-A 血脉（关联索引） ====================

/** ref 约定常量（血脉）：
 *  - `memory:<name>`  关联主干记忆
 *  - `#t<turn_id>`    挂轮
 *  - `corr:<id>`      挂派单/通信
 *  - `升:memory:<name>` 升格产物 */
const REF = {
  memory: (name) => `memory:${name}`,
  turn: (turnId) => `#t${turnId}`,
  corr: (id) => `corr:${id}`,
  promote: (name) => `升:memory:${name}`,
};

function stripEvent(r) {
  return { id: r.id, sessionId: r.session_id, gen: r.gen, turnId: r.turn_id, seq: r.seq, kind: r.kind, payload: String(r.payload || ''), ts: r.ts, ref: String(r.ref || ''), corrId: String(r.corr_id || '') };
}

/** 设置某事件的 ref（血脉连线）。@returns {ok, changed} */
function linkEvent(sessionId, eventId, ref, opts = {}) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, error: 'db-unavailable' };
    const sid = String(sessionId), id = Number(eventId);
    if (!sid || !Number.isInteger(id) || id <= 0) return { ok: false, error: 'bad-args' };
    const sets = ['ref = ?'], vals = [String(ref == null ? '' : ref)];
    if (opts && opts.corrId != null) { sets.push('corr_id = ?'); vals.push(String(opts.corrId)); }
    vals.push(sid, id);
    const r = db.prepare(`UPDATE branch_event SET ${sets.join(', ')} WHERE session_id = ? AND id = ?`).run(...vals);
    return { ok: true, changed: Number(r && r.changes) || 0 };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 顺藤摸瓜：返回目标事件 + 关联链（同 turn_id / 同 ref / corr_id 命中）。**只读、有界 ≤50 条**。 */
function trace(sessionId, eventId, opts = {}) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, error: 'db-unavailable' };
    const sid = String(sessionId), id = Number(eventId);
    if (!sid || !Number.isInteger(id) || id <= 0) return { ok: false, error: 'bad-args' };
    const LIMIT = Math.max(1, Math.min(50, Number(opts.limit) || 50));
    const row = db.prepare('SELECT * FROM branch_event WHERE session_id = ? AND id = ? LIMIT 1').get(sid, id);
    if (!row) return { ok: false, error: 'event-not-found' };
    const target = stripEvent(row);
    const seen = new Set([target.id]);
    const out = [];
    const add = (rows, via) => {
      for (const r of rows) {
        if (out.length >= LIMIT) return;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ ...stripEvent(r), via });
      }
    };
    // 关联优先级：**强关联先入链**（派单/同源 > 同轮），避免同轮噪音吃满额度把强关联挤出。
    // ① corr_id 命中（挂派单；含 ref=`corr:<id>` 写法）
    const corr = target.corrId || (target.ref.startsWith('corr:') ? target.ref.slice(5) : '');
    if (corr) {
      add(db.prepare('SELECT * FROM branch_event WHERE session_id = ? AND corr_id = ? ORDER BY seq ASC LIMIT 200').all(sid, corr), 'corr');
      add(db.prepare('SELECT * FROM branch_event WHERE session_id = ? AND ref = ? ORDER BY seq ASC LIMIT 200').all(sid, 'corr:' + corr), 'corr-ref');
    }
    // ② 同 ref（同源/升格互指）
    if (target.ref && !target.ref.startsWith('corr:')) add(db.prepare('SELECT * FROM branch_event WHERE session_id = ? AND ref = ? ORDER BY seq ASC LIMIT 200').all(sid, target.ref), 'same-ref');
    // ③ 同 turn_id（挂轮；量最大、优先级最低）
    if (target.turnId) add(db.prepare('SELECT * FROM branch_event WHERE session_id = ? AND turn_id = ? ORDER BY seq ASC LIMIT 200').all(sid, target.turnId), 'same-turn');
    return { ok: true, target, related: out, total: out.length, limit: LIMIT };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ==================== v4-4 T-B 升格（工具驱动 · 不自动） ====================

const PROMOTE_KINDS = new Set(['decision', 'fruit', 'note']);

/** 升格：果/决定/记 → 主干记忆。写 `data/memory/<name>.md`（格式对齐现有记忆；utf-8 无 BOM；同名追加不覆盖）+ 回写 ref。
 *  **仅显式调用触发**（防主干污染）；同一事件重复升格 → 幂等跳过。 */
function promote(sessionId, eventId, memoryName, opts = {}) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, error: 'db-unavailable' };
    const sid = String(sessionId), id = Number(eventId);
    const name = String(memoryName || '').trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!sid || !Number.isInteger(id) || id <= 0) return { ok: false, error: 'bad-args' };
    if (!name) return { ok: false, error: 'missing-memory-name' };
    if (!hasRefCols) return { ok: false, error: 'ref-column-unavailable' };
    const row = db.prepare('SELECT * FROM branch_event WHERE session_id = ? AND id = ? LIMIT 1').get(sid, id);
    if (!row) return { ok: false, error: 'event-not-found' };
    const ev = stripEvent(row);
    if (!PROMOTE_KINDS.has(ev.kind)) return { ok: false, error: 'kind-not-promotable', kind: ev.kind };
    const ref = REF.promote(name);
    if (ev.ref === ref) return { ok: true, skipped: true, ref, reason: 'already-promoted' };
    const dir = path.join(DATA_DIR, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.md');
    const content = `（升格自支干 · session=${ev.sessionId} gen=${ev.gen} 轮=${ev.turnId || '-'} 事件#${ev.id}）\n${String(ev.payload || '').trim()}`;
    let appended = false;
    if (fs.existsSync(file)) {
      if (!opts.skipBackup) { try { fs.copyFileSync(file, `${file}.bak_promote_${Date.now()}`); } catch { } }
      fs.appendFileSync(file, `\n\n## ${new Date().toISOString().slice(0, 10)}\n${content}\n`, 'utf8');
      appended = true;
    } else {
      fs.writeFileSync(file, `# ${name}\n\n${content}\n`, 'utf8');
    }
    // 无 BOM 校验（写入后立即断言；异常则纠正）
    try { if (fs.readFileSync(file).subarray(0, 3).toString('hex') === 'efbbbf') fs.writeFileSync(file, fs.readFileSync(file, 'utf8'), 'utf8'); } catch { }
    if (!opts.dryRun) db.prepare('UPDATE branch_event SET ref = ? WHERE session_id = ? AND id = ?').run(ref, sid, id);
    return { ok: true, file, ref, appended, event: ev };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ==================== v4-4 T-C 周期压缩（开关默认关 · 手工/显式） ====================

/** 周期压缩：保留最近 keepTurns 条 turn（及其挂载事件），更老 turn 按 gen 折叠为一条 `turn-ring` 摘要事件。
 *  **事务 + 临时表 + rename 原子**；失败回滚。`seq` 只增不复用。默认不自动调用（见 maybeAutoCompact）。 */
function compact(sessionId, keepTurns = 200, opts = {}) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, error: 'db-unavailable' };
    const sid = String(sessionId);
    const keep = Math.max(1, Number(keepTurns) || 200);
    if (!sid) return { ok: false, error: 'bad-args' };
    // ⚠️ 2026-09-19 事故修复：**必须读全表**——旧实现 `WHERE session_id=?` 只取目标会话，
    //   而末尾 `DROP TABLE branch_event` 是**全表**重建 → 其他会话事件全灭（311条/8会话 → 2条）。
    //   现：全表读取；keepRows = **其他会话全部行原样保留** + 本会话保留行；仅对本会话 oldTurns 折叠 ring。
    const allRows = db.prepare('SELECT * FROM branch_event ORDER BY seq ASC').all();
    const sessRows = allRows.filter((r) => String(r.session_id) === sid);
    if (!sessRows.length) return { ok: true, compacted: 0, note: 'no-events' };
    const turnRows = sessRows.filter((r) => r.kind === 'turn');
    const maxSeq = allRows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);   // 全局最大 seq（防新 ring seq 碰撞）
    if (turnRows.length <= keep) return { ok: true, compacted: 0, note: 'nothing-to-do', turns: turnRows.length, events: allRows.length };
    const keepSet = new Set(turnRows.slice(-keep).map((r) => String(r.turn_id)));
    const oldTurns = turnRows.slice(0, turnRows.length - keep);
    const oldTurnIds = new Set(oldTurns.map((r) => String(r.turn_id)));
    // 按 gen 折叠为 turn-ring 摘要（每条 ≤120 字）
    const byGen = new Map();
    for (const t of oldTurns) {
      const g = Number.isFinite(Number(t.gen)) ? Number(t.gen) : 0;
      if (!byGen.has(g)) byGen.set(g, []);
      byGen.get(g).push(t);
    }
    let seq = maxSeq;
    const rings = [];
    for (const g of [...byGen.keys()].sort((a, b) => a - b)) {
      const list = byGen.get(g);
      let sum = '';
      try { const o = JSON.parse(list[list.length - 1].payload); sum = String((o && o.summary) || ''); } catch { sum = String(list[list.length - 1].payload || ''); }
      const payload = (`年轮 g${g}：${list.length} 轮｜` + sum.replace(/\s+/g, ' ').trim()).slice(0, 120);
      rings.push({ session_id: sid, gen: g, turn_id: '', seq: ++seq, kind: 'turn-ring', payload, ts: Number(list[list.length - 1].ts) || Date.now(), ref: '', corr_id: '' });
    }
    // 其他会话：**全部原样保留**（不折叠、不丢失）
    const otherRows = allRows.filter((r) => String(r.session_id) !== sid);
    const keepSessRows = sessRows.filter((r) => {
      if (r.kind === 'turn') return keepSet.has(String(r.turn_id));
      if (r.kind === 'turn-ring') return true;                                  // 已有年轮保留（幂等）
      if (r.kind === 'goal') return true;                                       // 批B：首代目标独立标记 —— 永不折叠（compact 不丢）
      if (r.turn_id && oldTurnIds.has(String(r.turn_id))) return false;         // 老轮的挂载事件 → 随轮折叠
      return true;                                                              // 无轮归属的事件保留
    });
    const keepRows = otherRows.concat(keepSessRows);
    const DDL = `CREATE TABLE branch_event (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        gen         INTEGER NOT NULL DEFAULT 0,
        turn_id     TEXT    NOT NULL DEFAULT '',
        seq         INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        payload     TEXT    NOT NULL DEFAULT '',
        ts          INTEGER NOT NULL,
        ref         TEXT    NOT NULL DEFAULT '',
        corr_id     TEXT    NOT NULL DEFAULT '',
        turn_no     INTEGER,
        sub_seq     INTEGER,
        origin      TEXT,
        topic_key   TEXT
      )`;
    const ins = (tbl) => db.prepare(`INSERT INTO ${tbl} (id, session_id, gen, turn_id, seq, kind, payload, ts, ref, corr_id, turn_no, sub_seq, origin, topic_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP TABLE IF EXISTS branch_event_new');
      db.exec(DDL.replace('CREATE TABLE branch_event', 'CREATE TABLE branch_event_new'));
      const st = ins('branch_event_new');
      for (const r of keepRows) st.run(r.id, r.session_id, r.gen, r.turn_id, r.seq, r.kind, r.payload, r.ts, r.ref, r.corr_id, r.turn_no == null ? null : r.turn_no, r.sub_seq == null ? null : r.sub_seq, r.origin == null ? null : r.origin, r.topic_key == null ? null : r.topic_key);
      for (const r of rings) st.run(null, r.session_id, r.gen, r.turn_id, r.seq, r.kind, r.payload, r.ts, r.ref, r.corr_id, r.turn_no == null ? null : r.turn_no, r.sub_seq == null ? null : r.sub_seq, r.origin == null ? null : r.origin, r.topic_key == null ? null : r.topic_key);
      db.exec('DROP TABLE branch_event');
      db.exec('ALTER TABLE branch_event_new RENAME TO branch_event');
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_ts   ON branch_event(session_id, ts)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_kind ON branch_event(session_id, kind)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_ref  ON branch_event(session_id, ref)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_turnno ON branch_event(session_id, turn_no)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_be_sid_topic  ON branch_event(session_id, topic_key)');
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_be_turn ON branch_event(session_id, turn_id) WHERE kind='turn'");
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { }
      return { ok: false, error: String((e && e.message) || e), rolledBack: true };
    }
    const after = db.prepare('SELECT COUNT(*) AS c FROM branch_event WHERE session_id = ?').get(sid);
    return { ok: true, compacted: oldTurns.length, rings: rings.length, turnsBefore: turnRows.length, turnsAfter: keep, eventsBefore: sessRows.length, eventsAfter: Number(after && after.c) || 0, otherSessionsKept: otherRows.length, seq };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 自动压缩钩子：**仅当 config.branchAutoCompact === true** 时执行（默认 false → 立即返回，零副作用）。 */
function maybeAutoCompact(sessionId, keepTurns) {
  try {
    if (require('./config').load().branchAutoCompact !== true) return { ok: true, skipped: true, reason: 'branchAutoCompact=false' };
  } catch { return { ok: true, skipped: true, reason: 'config-unavailable' }; }
  return compact(sessionId, keepTurns);
}

// ==================== P1·账本决定 → 支干 幂等种子迁移 ====================

/** 从账本 `_progress.md` 文本抽取 KEY 区条目（`- [决定] …` 及所有非复选框的 `- ` 行），保持文件原始顺序。
 *  **只读文本**，不改账本。返回 { found, entries }（entries 已去首部列表标记并 trim）。 */
function extractLedgerKeyEntries(ledgerText) {
  try {
    const t = String(ledgerText == null ? '' : ledgerText).replace(/\r\n?/g, '\n');
    const m = t.match(/<!--\s*KEY:BEGIN\s*-->([\s\S]*?)<!--\s*KEY:END\s*-->/);
    const block = m ? m[1] : '';
    if (!block) return { found: 0, entries: [] };
    const entries = [];
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!/^[-*]\s+/.test(line)) continue;                       // 只认列表行
      if (/^[-*]\s*\[[ xX✓✔]\]/.test(line)) continue;             // 排除复选框行（TODO 类）
      const clean = line.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
      if (clean) entries.push(clean);
    }
    return { found: entries.length, entries };
  } catch { return { found: 0, entries: [] }; }
}

/** P1：把账本 KEY 区决定**幂等**迁入支干（`kind='decision'`）。
 *  - **去重键 = payload 文本**（迁移前查库；同 payload 已存在 → 跳过）
 *  - **顺序**：账本来源的决定统一安置在**负数 seq 空间**（`-K..-1`，K=已迁入条数），
 *    使其排在现有正 seq 事件之前、且严格保持账本原始顺序；
 *    于是 `fold().decisions.slice(-40)` = 账本最新 ~40 条决定（与 P0 修复后的账本 KEY 区口径一致）。
 *  - **可重复执行**：每轮按"当前账本顺序"对负数空间**重排**（幂等；已存在条目零写入），
 *    故"先迁移 → 后又新增条目 → 再迁移"不会产生 seq 冲突或乱序。
 *  - 只写 branch.db；异常 → {ok:false}（事务回滚）。 */
function seedDecisionsFromLedger(sessionId, ledgerText, opts = {}) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, error: 'db-unavailable' };
    const sid = String(sessionId || '');
    if (!sid) return { ok: false, error: 'bad-args' };
    const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const dry = opts.dryRun === true;
    const { found, entries } = extractLedgerKeyEntries(ledgerText);
    if (!found) return { ok: true, inserted: 0, skipped: 0, found: 0, note: 'no-key-entries' };
    // 账本顺序（去重）+ payload → 账本下标
    const ledgerIdx = new Map();
    for (const raw of entries) {
      const clean = norm(raw);
      if (!clean || ledgerIdx.has(clean)) continue;
      ledgerIdx.set(clean, ledgerIdx.size);
    }
    const ledger = [...ledgerIdx.keys()].sort((a, b) => ledgerIdx.get(a) - ledgerIdx.get(b));
    // 库内已有 decision payload（去重键，任意 seq）
    const existRows = db.prepare("SELECT payload FROM branch_event WHERE session_id = ? AND kind = 'decision'").all(sid);
    const exist = new Set(existRows.map((r) => norm(r.payload)));
    const todo = ledger.filter((c) => !exist.has(c));
    const skipped = ledger.length - todo.length;
    const tsOf = (t) => { try { const mm = String(t).match(/(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})/); return mm ? Date.parse(`${mm[1]}-${String(mm[2]).padStart(2, '0')}-${String(mm[3]).padStart(2, '0')}T00:00:00+08:00`) : 0; } catch { return 0; } };
    let inserted = 0, renumbered = 0, K = 0;
    if (!dry) db.exec('BEGIN IMMEDIATE');
    try {
      if (todo.length && !dry) {
        const ins = db.prepare("INSERT INTO branch_event (session_id, gen, turn_id, seq, kind, payload, ts, ref, corr_id) VALUES (?,?,?,?,?,?,?,?,?)");
        const minSeqRaw = Number(db.prepare('SELECT COALESCE(MIN(seq), 0) AS m FROM branch_event WHERE session_id = ?').get(sid).m) || 0;
        const base = Math.min(minSeqRaw, 0) - 1;                 // 占位必须 <0 且低于现有最小值（随后统一重排）
        for (let k = 0; k < todo.length; k++) ins.run(sid, 0, '', base - k, 'decision', todo[k], tsOf(todo[k]), '', '');
      }
      inserted = dry ? todo.length : todo.length;
      // —— 幂等重排：所有 seq<0 的决定（本轮新插入 + 历轮迁入）按**当前账本顺序**赋 seq = -K..-1 ——
      const rows = dry ? [] : db.prepare("SELECT id, payload, seq FROM branch_event WHERE session_id = ? AND kind = 'decision' AND seq < 0").all(sid);
      const seeded = rows
        .map((r) => ({ id: r.id, seq: Number(r.seq), idx: ledgerIdx.has(norm(r.payload)) ? ledgerIdx.get(norm(r.payload)) : -1 }))
        .filter((x) => x.idx >= 0)
        .sort((a, b) => a.idx - b.idx);
      K = seeded.length;
      if (!dry) {
        const upd = db.prepare('UPDATE branch_event SET seq = ? WHERE id = ? AND session_id = ?');
        for (let pos = 0; pos < K; pos++) {
          const want = -(K - pos);
          if (seeded[pos].seq !== want) { upd.run(want, seeded[pos].id, sid); renumbered++; }
        }
      }
      if (!dry) db.exec('COMMIT');
    } catch (e) {
      if (!dry) { try { db.exec('ROLLBACK'); } catch { } }
      return { ok: false, error: String((e && e.message) || e), rolledBack: true };
    }
    return { ok: true, inserted, skipped, renumbered, found, ledger: ledger.length, dryRun: dry, seqFrom: K ? -K : undefined, seqTo: K ? -1 : undefined, note: inserted ? undefined : 'no-new' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 启动路径开关：**仅当 `config.branchSeedFromLedger === true`** 才执行迁移；默认 false → 立即返回（零副作用）。 */
function maybeSeedFromLedger(sessionId, ledgerText) {
  try {
    if (require('./config').load().branchSeedFromLedger !== true) return { ok: true, skipped: true, reason: 'branchSeedFromLedger=false' };
  } catch { return { ok: true, skipped: true, reason: 'config-unavailable' }; }
  return seedDecisionsFromLedger(sessionId, ledgerText);
}

/** P0⑦：给某轮的全部事件打 topic_key（枝键）。精确按 (session_id, turn_id) 更新，无通配删除/DDL。
 *  用于 log_progress 带 topic 时把当前轮归入显式枝。幂等（可重复调用）。
 *  @returns {{ok:boolean, changed:number, reason?:string}} */
function setTurnTopic(sessionId, turnId, topicKey) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, changed: 0, reason: 'no-db' };
    if (!hasNewCols) return { ok: false, changed: 0, reason: 'no-cols' };
    const sid = String(sessionId || ''), tid = String(turnId || ''), tk = String(topicKey || '').trim();
    if (!sid || !tid || !tk) return { ok: false, changed: 0, reason: 'args' };
    const r = db.prepare('UPDATE branch_event SET topic_key=? WHERE session_id=? AND turn_id=?').run(tk, sid, tid);
    return { ok: true, changed: Number((r && r.changes) || 0) };
  } catch (e) { return { ok: false, changed: 0, reason: String((e && e.message) || e) }; }
}

/** 批B·tag：把某会话 turn_no∈[from,to]（含端点）的**全部**事件批量打 topic_key（枝键）。
 *  精确 `UPDATE branch_event SET topic_key=? WHERE session_id=? AND turn_no BETWEEN ? AND ?`（无通配/裸删/DDL）。
 *  幂等：仅更新 topic_key IS NULL 或 ≠ 目标枝键的行，故重复调用 changes=0。
 *  @returns {{ok:boolean, events:number, turns:number, before:number, after:number, totalRange:number, reason?:string}} */
function setRangeTopic(sessionId, from, to, topicKey, opts = {}) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, events: 0, turns: 0, before: 0, after: 0, totalRange: 0, reason: 'no-db' };
    if (!hasNewCols) return { ok: false, events: 0, turns: 0, before: 0, after: 0, totalRange: 0, reason: 'no-cols' };
    const sid = String(sessionId || ''), tk = String(topicKey || '').trim();
    const f = Number(from), t = Number(to);
    if (!sid || !tk || !Number.isFinite(f) || !Number.isFinite(t)) return { ok: false, events: 0, turns: 0, before: 0, after: 0, totalRange: 0, reason: 'args' };
    const lo = Math.min(f, t), hi = Math.max(f, t);
    const rng = 'session_id=? AND turn_no IS NOT NULL AND turn_no BETWEEN ? AND ?';
    // A2（2026-09-25）：nullOnly=true → 严格只补未归行（不覆盖已属其它枝）；默认 false 保持旧语义（可覆盖换键，兼容 action=tag）。
    const nullOnly = !!(opts && opts.nullOnly);
    const guard = rng + (nullOnly ? " AND (topic_key IS NULL OR topic_key='')" : ' AND (topic_key IS NULL OR topic_key<>?)');
    const gparams = nullOnly ? [sid, lo, hi] : [sid, lo, hi, tk];
    const b = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT turn_no) AS tn FROM branch_event WHERE ${guard}`).get(...gparams);
    const _setRng = hasTopicSource ? "topic_key=?, topic_source='manual'" : 'topic_key=?';
    const r = db.prepare(`UPDATE branch_event SET ${_setRng} WHERE ${guard}`).run(tk, ...gparams);
    const a = db.prepare(`SELECT COUNT(*) AS n FROM branch_event WHERE ${rng} AND topic_key=?`).get(sid, lo, hi, tk);
    const all = db.prepare(`SELECT COUNT(*) AS n FROM branch_event WHERE ${rng}`).get(sid, lo, hi);
    return { ok: true, events: Number((r && r.changes) || 0), turns: Number((b && b.tn) || 0), before: Number((b && b.n) || 0), after: Number((a && a.n) || 0), totalRange: Number((all && all.n) || 0) };
  } catch (e) { return { ok: false, events: 0, turns: 0, before: 0, after: 0, totalRange: 0, reason: String((e && e.message) || e) }; }
}

/** P2⑥：turnNo 全量回填——kind='turn' 且 turn_no IS NULL 的行按 ts 升序依次补 max+1。
 *  精确更新（仅 NULL 行）、幂等、不动已有编号（不重排、不跳号复用）。 */
function backfillTurnNo(sessionId) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, filled: 0, reason: 'no-db' };
    if (!hasNewCols) return { ok: false, filled: 0, reason: 'no-cols' };
    const sid = String(sessionId || '');
    if (!sid) return { ok: false, filled: 0, reason: 'no-sid' };
    const nulls = db.prepare("SELECT id FROM branch_event WHERE session_id=? AND kind='turn' AND turn_no IS NULL ORDER BY ts ASC, seq ASC").all(sid);
    if (!nulls.length) return { ok: true, filled: 0 };
    const mx = db.prepare("SELECT COALESCE(MAX(turn_no),0) AS m FROM branch_event WHERE session_id=? AND kind='turn'").get(sid);
    let n = Number(mx && mx.m) || 0;
    const st = db.prepare('UPDATE branch_event SET turn_no=? WHERE id=?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of nulls) { n += 1; st.run(n, row.id); }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { } return { ok: false, filled: 0, reason: String((e && e.message) || e) }; }
    return { ok: true, filled: nulls.length };
  } catch (e) { return { ok: false, filled: 0, reason: String((e && e.message) || e) }; }
}

/** P2⑤：在支干库内检索 decision/note/fruit 事件（按 payload 子串）。只读，有界。
 *  @returns {Array<{sessionId:string, kind:string, payload:string, ts:number}>} */
function searchEvents(keyword, limit = 8) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return [];
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const lim = Math.max(1, Math.min(50, Number(limit) || 8));
    // G3（2026-09-29）：把 kind='turn'（轮骨架）纳入检索命中源——此前只搜 decision/note/fruit，
    //   导致"搜骨架"命中的不是骨架本身。排序：decision/note/fruit 优先，turn 次之（同档按 ts DESC）。
    const _sel = hasNewCols
      ? "session_id, kind, payload, ts, turn_no"
      : "session_id, kind, payload, ts, NULL AS turn_no";
    const rows = db.prepare(`SELECT ${_sel} FROM branch_event
        WHERE kind IN ('decision','note','fruit','turn') AND payload LIKE ?
        ORDER BY CASE kind WHEN 'decision' THEN 0 WHEN 'note' THEN 1 WHEN 'fruit' THEN 1 ELSE 2 END, ts DESC
        LIMIT ?`).all('%' + kw + '%', lim);
    return (rows || []).map((r) => ({ sessionId: String(r.session_id || ''), kind: String(r.kind || ''), payload: String(r.payload || ''), ts: Number(r.ts) || 0, turnNo: r.turn_no == null ? null : Number(r.turn_no) }));
  } catch { return []; }
}

/** A1'（2026-09-29）：自动归枝词法工具。
 *  _branchTerms：提取词元（中文 2-gram + 4-gram，英文词 ≥3 字符），滤停用词。
 *  4-gram 视为"强词"（匹配权重高）。仅用于比较，不改原文。 */
const BRANCH_STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '已经', '现在', '所以', '因为', '但是', '如果', '就是', '没有', '还是', '需要', '进行', '通过', '时候', '问题', '一下', '这些', '那些', '这里', '那里', '不是', '可能', '应该', '以及', '并且', '然后', '这样', '那样', '一个', '自己', '目前', '很多', '非常', '必须', '直接', '简单', '关于', '对于', '其中', '之后', '之前', '由于', '根据', '为了', '是否', '如何', '哪些', '首先', '其次', '最后', '总之', '例如', '比如', '起来', '出来', '进来', '回来', '下来', '上去', '过去', '一般', '基本', '主要', '重点', '建议', '方案', '任务', '情况', '结果', '内容', '部分', '方面', '方式', '方法', '地方', '东西', '事情', '时间',
]);
function _branchTerms(text) {
  const t = String(text || '');
  const terms = [];
  const en = t.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || [];
  for (const w of en) terms.push(w.toLowerCase());
  const zhSegs = t.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of zhSegs) {
    for (let i = 0; i + 2 <= seg.length; i++) { const w = seg.slice(i, i + 2); if (!BRANCH_STOP.has(w)) terms.push(w); }
    for (let i = 0; i + 4 <= seg.length; i++) terms.push(seg.slice(i, i + 4));   // 4-gram 强词，不滤（长度足够不可能是停用词）
  }
  return terms;
}
function _termWeight(w) { return (String(w).length >= 4) ? 3 : 1; }   // 长词/英文词权重高
function _charBigrams(s) { const t = String(s || '').replace(/\s+/g, ''); const set = new Set(); for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2)); if (!set.size && t) set.add(t); return set; }
function _jaccard(a, b) { if (!a.size || !b.size) return 0; let inter = 0; for (const x of a) if (b.has(x)) inter++; const uni = a.size + b.size - inter; return uni ? inter / uni : 0; }

/** A1'（2026-09-29·重写）：自动归枝（规则法·零成本·宁缺勿错）。
 *  根因修复：旧版把「轮摘要」与「枝键名」互包含比较 → 枝名是主题名词、摘要是完整句 → 恒 no-match。
 *  现改为比「该枝历史内容」：
 *   ① 枝关键词表：每枝取其 turn summary（最近 N≤50 条）提取词元、计频 → 词表；
 *   ② 匹配：新轮词元与各枝词表比对，得分=命中词加权（长词权重3/短词1），取最高分枝，须 ≥ minHits；
 *   ③ 兜底：词全不命中 → 字符 bigram Jaccard 与新轮摘要 vs 枝代表文本，≥0.33 取最优；
 *   ④ 仍保守：不达阈值留 NULL 不猜；reason=matched/no-match/too-short/disabled。
 *  配置：config.branchAutoAssign {enabled:true, minHits:2, samplesPerBranch:50}（缺省内置默认）。
 *  严格只补未归行（WHERE topic_key IS NULL OR ''），绝不覆盖已属其它枝；异常静默。
 *  @returns {{ok:boolean, assigned:number, topic?:string, reason?:string, score?:number}} */
function autoAssignTopic(sessionId, turnNo, summaryText) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, assigned: 0, reason: 'no-db' };
    if (!hasNewCols) return { ok: false, assigned: 0, reason: 'no-cols' };
    const sid = String(sessionId || '');
    const tn = Number(turnNo);
    if (!sid || !Number.isFinite(tn)) return { ok: false, assigned: 0, reason: 'args' };
    const raw = String(summaryText || '').trim();
    if (!raw || normBodyKey(raw).length < 4) return { ok: true, assigned: 0, reason: 'too-short' };
    let cfgAA = {};
    try { cfgAA = (require('./config').load().branchAutoAssign) || {}; } catch { }
    if (cfgAA.enabled === false) return { ok: true, assigned: 0, reason: 'disabled' };
    const MIN_HITS = Number.isFinite(Number(cfgAA.minHits)) ? Number(cfgAA.minHits) : 2;
    const N_PER_BRANCH = Math.max(5, Math.min(50, Number(cfgAA.samplesPerBranch) || 50));
    // ① 枝历史文本与词表（按归一 topic_key 分组）—— 每枝只取**最近 N_PER_BRANCH 条**轮摘要，
    //   词表基于该窗口构建（旧版累积全部轮 → 大枝覆盖过广、吞并一切，实测 9 轮回放全判给最大枝）。
    const rows = db.prepare("SELECT topic_key, payload FROM branch_event WHERE session_id=? AND kind='turn' AND topic_key IS NOT NULL AND topic_key<>'' ORDER BY turn_no ASC").all(sid);
    const branches = new Map();
    for (const r of rows) {
      const canon = normalizeTopicKey(r.topic_key); if (!canon) continue;
      if (!branches.has(canon)) branches.set(canon, { terms: new Map(), text: [] });
      const b = branches.get(canon);
      let summary = r.payload;
      try { const o = JSON.parse(r.payload); if (o && typeof o === 'object') summary = o.summary || ''; } catch { }
      b.text.push(String(summary || ''));
      if (b.text.length > N_PER_BRANCH) b.text.shift();
    }
    if (!branches.size) return { ok: true, assigned: 0, reason: 'no-branch' };
    for (const b of branches.values()) {
      b.terms = new Map();
      for (const s of b.text) for (const w of _branchTerms(s)) b.terms.set(w, (b.terms.get(w) || 0) + 1);
    }
    // 跨枝通用词过滤（IDF 近似）：出现在 > max(2, 枝数/2) 个枝的词视为通用词，剔除——
    //   治"大枝靠通用词碾压小枝"的偏置（实测旧版 9 轮回放全被判给最大枝）。
    const df = new Map();
    for (const b of branches.values()) for (const w of b.terms.keys()) df.set(w, (df.get(w) || 0) + 1);
    const DF_CUT = Math.max(2, Math.ceil(branches.size * 0.5));
    const isCommon = (w) => (df.get(w) || 0) > DF_CUT;
    const assign = (topic, reason, score) => {
      const _sets = hasTopicSource ? "topic_key=?, topic_source='auto'" : 'topic_key=?';
      const r = db.prepare(`UPDATE branch_event SET ${_sets} WHERE session_id=? AND turn_no=? AND (topic_key IS NULL OR topic_key='')`).run(topic, sid, tn);
      return { ok: true, assigned: Number((r && r.changes) || 0), topic, reason, score };
    };
    // ② 词表匹配
    const newSet = new Set(_branchTerms(raw));
    let best = null, bestScore = 0;
    for (const [canon, b] of branches) {
      let score = 0;
      for (const w of newSet) if (!isCommon(w) && b.terms.has(w)) score += _termWeight(w);
      if (score > bestScore) { bestScore = score; best = canon; }
    }
    if (best && bestScore >= MIN_HITS) return assign(best, 'matched', bestScore);
    // ③ bigram Jaccard 兜底
    const nb = _charBigrams(raw);
    let jBest = null, jBestV = 0;
    for (const [canon, b] of branches) { const v = _jaccard(nb, _charBigrams(b.text.join(' '))); if (v > jBestV) { jBestV = v; jBest = canon; } }
    if (jBest && jBestV >= 0.33) return assign(jBest, 'matched-sim', Math.round(jBestV * 100) / 100);
    return { ok: true, assigned: 0, reason: 'no-match' };
  } catch (e) { return { ok: false, assigned: 0, reason: String((e && e.message) || e) }; }
}

/** B（2026-09-25）：会话树数据 API 源（前端泳道图）。复用 fold，勿重写读取逻辑。
 *  @returns {{sessionId, mainAxis, branches, decisions, todos, pendingPfx}} */
function sessionTree(sessionId, keepTurns = 200, ext = null) {
  const sid = String(sessionId || '');
  let f = {};
  try { f = fold(sid, Math.max(20, Number(keepTurns) || 200), ext) || {}; } catch { f = {}; }
  const turns = Array.isArray(f.turns) ? f.turns : [];
  const axis = turns.slice(-Math.max(1, Number(keepTurns) || 200)).map((t) => ({
    turn_no: t.turnNo,
    kind: t.origin === 'user' ? 'user' : (t.origin || 'turn'),
    topic_key: normalizeTopicKey(t.topicKey) || null,
    ts: Number(t.ts) || 0,
    title: String(t.summary || '').slice(0, 120),
  }));
  const byTopic = new Map();
  const ITEMS_PER_KIND = 60;   // 各 kind 条目上限（超出截断）
  const mkItem = (tno, kind, ts, title) => ({ turn_no: tno, kind, ts: Number(ts) || 0, title: String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 200) });
  for (const t of turns) {
    const k = normalizeTopicKey(t.topicKey);
    if (!k) continue;
    if (!byTopic.has(k)) byTopic.set(k, { topic_key: k, count: 0, turnFrom: null, turnTo: null, kinds: {}, nodes: [], itemsByKind: {}, itkTruncated: {}, _turns: new Set() });
    const b = byTopic.get(k);
    const tn = t.turnNo == null ? null : Number(t.turnNo);
    if (tn != null && !b._turns.has(tn)) { b._turns.add(tn); b.count++; }
    if (tn != null) { b.turnFrom = (b.turnFrom == null ? tn : Math.min(b.turnFrom, tn)); b.turnTo = (b.turnTo == null ? tn : Math.max(b.turnTo, tn)); }
    b.kinds['turn'] = (b.kinds['turn'] || 0) + 1;
    const turnNode = { turn_no: tn, kind: 'turn', ts: Number(t.ts) || 0, title: String(t.summary || '').slice(0, 120) };
    b.nodes.push(turnNode);
    // F1（2026-09-29）：各 kind 真实条目（前端点任意叶都能出明细）——turn 用轮摘要，其余用事件 payload
    //   截断策略=保留**最新** ITEMS_PER_KIND 条（大枝旧条目被裁），故此处全收、末段统一 slice(-N)。
    const pushItem = (kind, item) => { const arr = b.itemsByKind[kind] || (b.itemsByKind[kind] = []); arr.push(item); };
    pushItem('turn', mkItem(tn, 'turn', t.ts, t.summary));
    for (const ev of (t.events || [])) {
      const ek = String(ev.kind || ''); if (!ek) continue;
      b.kinds[ek] = (b.kinds[ek] || 0) + 1;
      pushItem(ek, mkItem(tn, ek, ev.ts, ev.payload));
    }
  }
  for (const b of byTopic.values()) {
    for (const k of Object.keys(b.itemsByKind)) {
      const arr = b.itemsByKind[k];
      if (arr.length > ITEMS_PER_KIND) { b.itemsByKind[k] = arr.slice(-ITEMS_PER_KIND); b.itkTruncated[k] = true; }
    }
  }
  const branches = [...byTopic.values()].map((b) => { delete b._turns; return b; }).sort((a, b) => b.count - a.count);
  return {
    sessionId: sid,
    mainAxis: axis,
    branches,
    decisions: (f.decisions || []).slice(-20),
    todos: (f.openTodos || []).slice(0, 20),
    pendingPfx: (f.pendingPfx || []).slice(0, 20),
  };
}

// ==================== A1''（2026-09-29）：整代批量重整（规则聚类 + LLM 分组） ====================
/** 元数据读写（branch_meta：幂等标记等）。异常静默返回 null/false。 */
function getMeta(k) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return null;
    const r = db.prepare('SELECT v FROM branch_meta WHERE k=?').get(String(k));
    return r ? String(r.v) : null;
  } catch { return null; }
}
function setMeta(k, v) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return false;
    db.prepare('INSERT OR REPLACE INTO branch_meta (k,v) VALUES (?,?)').run(String(k), String(v));
    return true;
  } catch { return false; }
}

/** 该轮是否可被重整：来源 auto，或本无主题（NULL/空）。manual 且有主题 → 绝不覆盖。 */
function _reflowEligible(topicSource, topicKey) {
  const ts = topicSource == null ? '' : String(topicSource);
  const tk = topicKey == null ? '' : String(topicKey);
  return ts === 'auto' || tk === '';
}

/** IDF 降权 + 长词加权：为每条素材建词元权重向量（就地写 it.vec）。 */
function _rfNum(v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; }
function _vectorize(items) {
  const N = Math.max(1, items.length);
  const df = new Map();
  for (const it of items) { const s = new Set(it.terms); for (const w of s) df.set(w, (df.get(w) || 0) + 1); }
  for (const it of items) {
    const v = new Map();
    for (const w of it.terms) {
      const idfW = Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1;
      v.set(w, (v.get(w) || 0) + _termWeight(w) * idfW);
    }
    it.vec = v;
  }
}
function _cos(a, b) { let dot = 0, na = 0, nb = 0; for (const [w, v] of a) { na += v * v; if (b.has(w)) dot += v * b.get(w); } for (const v of b.values()) nb += v * v; return (na && nb) ? dot / Math.sqrt(na * nb) : 0; }
function _topTerms(acc, n) { return [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]); }
function _fallbackTopicName(members) {
  const acc = new Map();
  for (const m of members) for (const [w, v] of m.vec) acc.set(w, (acc.get(w) || 0) + v);
  const top = _topTerms(acc, 3).filter((w) => w.length >= 2);
  return top.join('·').slice(0, 16) || '自动簇';
}

/** A1''（2026-09-29）：整代批量重整。规则聚类（IDF/互斥/低阈留 NULL/份额≤40%）+ LLM 分组命名。
 *  - 输入：该代各轮 payload/detail（引擎侧读，绝不返回整代内容）。
 *  - 只动 topic_source='auto' 或本无主题的行；manual 且有主题的行 100% 不覆盖。
 *  - 幂等：branch_meta 记 reflowedGen:<sid>=gen，已处理则跳过。事务写回，异常 ROLLBACK；跑前快照可回滚。
 *  - LLM 失败/非法 → 退回规则名，流程不中断。
 *  @param {string} sessionId
 *  @param {number} gen 目标代
 *  @param {object} [opts] { minScore?, llmGroup?(clusters,ctx)->{idx:name}, clusterSim?, capRatio? }
 *  @returns {Promise<{ok:boolean,reason:string,line:string,gen:number,turns:number,changed:number,clusters:number,llm:string}>} */
async function reflowGen(sessionId, gen, opts = {}) {
  const ret = { ok: false, reason: '', line: '', gen: Number(gen), turns: 0, changed: 0, clusters: 0, llm: 'skip' };
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) { ret.reason = 'no-db'; return ret; }
    if (!hasNewCols || !hasTopicSource) { ret.reason = 'no-cols'; return ret; }
    const sid = String(sessionId || ''); const g = Number(gen);
    if (!sid || !Number.isFinite(g)) { ret.reason = 'args'; return ret; }
    const doneKey = 'reflowedGen:' + sid;
    const force = !!(opts && opts.force);   // force=true：一次性重判（含 manual 行；仅供离线回测/存量重判，不用于自动触发）
    let _rf = {}; try { _rf = (require('./config').load().branchReflow) || {}; } catch { }
    if (_rf.enabled === false && !force) { ret.reason = 'disabled'; return ret; }
    if (!force && getMeta(doneKey) === String(g)) { ret.ok = true; ret.reason = 'already'; ret.line = `归枝：第 ${g} 代已重整（幂等跳过）`; return ret; }
    // ① 素材（该代各轮 turn summary + detail），仅取可重整轮
    const tRows = db.prepare("SELECT turn_no, payload, topic_key, topic_source FROM branch_event WHERE session_id=? AND gen=? AND kind='turn' AND turn_no IS NOT NULL ORDER BY turn_no ASC").all(sid, g);
    const dMap = new Map();
    for (const r of db.prepare("SELECT turn_no, payload FROM branch_event WHERE session_id=? AND gen=? AND kind='detail' AND turn_no IS NOT NULL").all(sid, g)) dMap.set(Number(r.turn_no), String(r.payload || ''));
    const items = [];
    for (const r of tRows) {
      const tn = Number(r.turn_no);
      if (!force && !_reflowEligible(r.topic_source, r.topic_key)) continue;
      let s = String(r.payload || '');
      try { const o = JSON.parse(s); if (o && typeof o === 'object') { if (o.aborted) continue; s = String(o.summary || ''); } } catch { }
      const text = (s + ' ' + (dMap.get(tn) || '')).trim();
      if (!text || normBodyKey(text).length < 4) continue;
      items.push({ tn, text, old: (r.topic_key == null ? '' : String(r.topic_key)), terms: _branchTerms(text) });
    }
    ret.turns = items.length;
    if (items.length < 3) { ret.ok = true; ret.reason = 'too-few'; setMeta(doneKey, String(g)); ret.line = `归枝：第 ${g} 代可重整轮 ${items.length}（<3 跳过，已标处理）`; return ret; }
    // 会话级 detail 文本（供参考集也用上"工具+答复要点"，提升相似度判据）
    const dAll = new Map();
    try { for (const r of db.prepare("SELECT turn_no, payload FROM branch_event WHERE session_id=? AND kind='detail' AND turn_no IS NOT NULL").all(sid)) dAll.set(Number(r.turn_no), String(r.payload || '')); } catch { }
    // ② 参考集（**其它代**的已标轮）→ KNN 标签传播（关键词向量·IDF·互斥归 1 枝·低阈留 NULL）。
    //    **留出法**：本代不参与参考集，避免用本代自身（可能错误）的标签自我强化 → 逼近真实泛化。
    const _refRows = (gg) => db.prepare("SELECT topic_key, payload, turn_no FROM branch_event WHERE session_id=? AND kind='turn' AND topic_key IS NOT NULL AND topic_key<>''" + (gg == null ? '' : ' AND gen<>?') + ' ORDER BY turn_no ASC').all(...(gg == null ? [sid] : [sid, gg]));
    let vRows = _refRows(g); if (!vRows.length) vRows = _refRows(null);
    const refs = [];
    for (const r of vRows) {
      const tk = normalizeTopicKey(r.topic_key); if (!tk) continue;
      let s = String(r.payload || ''); try { const o = JSON.parse(s); if (o && typeof o === 'object') s = String(o.summary || ''); } catch { }
      const t = (s + ' ' + (dAll.get(Number(r.turn_no)) || '')).trim();
      if (!t) continue;
      refs.push({ tk, terms: _branchTerms(t) });
    }
    _vectorize(items.concat(refs));   // 查询集与参考集共享 IDF
    const MIN_SCORE = Number.isFinite(Number(opts && opts.minScore)) ? Number(opts.minScore) : _rfNum(_rf.minScore, 0);
    const KN = Math.max(1, Math.min(20, Number(_rfNum(_rf.knnK, 10))));
    const _dbg = (opts && opts.debug) ? [] : null;
    for (const it of items) {
      const sims = [];
      for (const r of refs) { const c = _cos(it.vec, r.vec); if (c > 0) sims.push([c, r.tk]); }
      if (!sims.length) { if (_dbg) _dbg.push({ tn: it.tn, old: it.old, best: null, score: 0 }); continue; }
      sims.sort((a, b) => b[0] - a[0]);
      const top = sims.slice(0, KN);
      const votes = new Map(); for (const [c, tk] of top) votes.set(tk, (votes.get(tk) || 0) + c);
      let bt = null, bv = 0; for (const [tk, v] of votes) if (v > bv) { bv = v; bt = tk; }
      if (_dbg) _dbg.push({ tn: it.tn, old: it.old, best: bt, score: Math.round(top[0][0] * 1000) / 1000 });
      if (bt && top[0][0] >= MIN_SCORE) { it.topic = bt; it.score = top[0][0]; }
    }
    // ③ 未归轮 → 簇内 leader 聚类（余弦，低阈留 NULL 不猜）
    const SIM = Number.isFinite(Number(opts && opts.clusterSim)) ? Number(opts.clusterSim) : _rfNum(_rf.clusterSim, 0.34);
    const clusters = [];
    for (const it of items.filter((x) => !x.topic)) {
      let bestC = null, bs = 0;
      for (const c of clusters) { const v = _cos(it.vec, c.centroid); if (v > bs) { bs = v; bestC = c; } }
      if (bestC && bs >= SIM) { bestC.members.push(it); for (const [w, v] of it.vec) bestC.acc.set(w, (bestC.acc.get(w) || 0) + v); bestC.centroid = bestC.acc; }
      else { const c = { members: [it], acc: new Map(it.vec), centroid: null }; c.centroid = c.acc; clusters.push(c); }
    }
    // ④ 单枝份额 ≤ capRatio（默认 40%）：超出者按分数降序保留前 N，其余退回 NULL（宁缺勿错）
    const CAPR = Number.isFinite(Number(opts && opts.capRatio)) ? Number(opts.capRatio) : _rfNum(_rf.capRatio, 0.4);
    const cap = Math.max(1, Math.floor(items.length * CAPR));
    const byTopic = new Map();
    for (const it of items) if (it.topic) { if (!byTopic.has(it.topic)) byTopic.set(it.topic, []); byTopic.get(it.topic).push(it); }
    for (const arr of byTopic.values()) if (arr.length > cap) { arr.sort((a, b) => (b.score || 0) - (a.score || 0)); for (let i = cap; i < arr.length; i++) { arr[i].topic = null; arr[i].score = 0; } }
    for (const c of clusters) if (c.members.length > cap) { c.members.sort((a, b) => _cos(b.vec, c.centroid) - _cos(a.vec, c.centroid)); for (let i = cap; i < c.members.length; i++) { c.members[i].drop = true; } }
    // ⑤ LLM 分组命名（另起一次小调用；失败/非法 → 退回规则名）
    ret.clusters = clusters.length;
    const llm = (opts && typeof opts.llmGroup === 'function') ? opts.llmGroup : null;
    let nameMap = null;
    if (llm && clusters.length) {
      try {
        const payload = clusters.map((c, i) => ({ idx: i, terms: _topTerms(c.acc, 5), samples: c.members.slice(0, 3).map((m) => String(m.text).slice(0, 60)) }));
        const r = await llm(payload, { sid, gen: g });
        if (r && typeof r === 'object') { nameMap = r; ret.llm = 'ok'; } else { ret.llm = 'fallback'; }
      } catch { ret.llm = 'fallback'; }
    }
    clusters.forEach((c, i) => {
      let name = (nameMap && nameMap[i] != null) ? String(nameMap[i]).trim() : '';
      if (!name || name.length > 24 || /[\r\n]/.test(name)) name = _fallbackTopicName(c.members);
      c.name = normalizeTopicKey(name) || name || ('自动簇' + (i + 1));
      for (const m of c.members) if (!m.drop) m.topic = c.name;
    });
    // ⑥ 回写（事务；只动 auto/NULL 行；跑前快照）
    const changes = [];
    for (const it of items) { if (it.topic && it.topic !== it.old) changes.push({ tn: it.tn, old: it.old, nu: it.topic }); }
    if (changes.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM branch_reflow_undo WHERE session_id=? AND gen=?').run(sid, g);
        const ins = db.prepare('INSERT INTO branch_reflow_undo (session_id, gen, turn_no, old_topic_key, ts) VALUES (?,?,?,?,?)');
        const _updWhere = force ? 'session_id=? AND turn_no=?' : "session_id=? AND turn_no=? AND (topic_source='auto' OR topic_key IS NULL OR topic_key='')";
        const upd = db.prepare(`UPDATE branch_event SET topic_key=?, topic_source='auto' WHERE ${_updWhere}`);
        for (const c of changes) { ins.run(sid, g, c.tn, c.old || '', Date.now()); const r = upd.run(c.nu, sid, c.tn); ret.changed += Number((r && r.changes) || 0); }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { } ret.reason = String((e && e.message) || e); return ret; }
    }
    setMeta(doneKey, String(g));
    ret.ok = true;
    if (_dbg) ret.debug = _dbg;
    ret.line = `归枝：第 ${g} 代 ${ret.turns} 轮，改 ${ret.changed} 行，簇 ${ret.clusters}，LLM=${ret.llm}`;
    return ret;
  } catch (e) { ret.reason = String((e && e.message) || e); return ret; }
}

/** 回滚某代重整（用跑前快照还原；并清幂等标记允许重跑）。 */
function reflowUndo(sessionId, gen) {
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) return { ok: false, reason: 'no-db' };
    const sid = String(sessionId || ''); const g = Number(gen);
    const rows = db.prepare('SELECT turn_no, old_topic_key FROM branch_reflow_undo WHERE session_id=? AND gen=? ORDER BY id ASC').all(sid, g);
    if (!rows.length) return { ok: true, restored: 0 };
    db.exec('BEGIN IMMEDIATE');
    let n = 0;
    try {
      const upd = db.prepare("UPDATE branch_event SET topic_key=?, topic_source='auto' WHERE session_id=? AND turn_no=? AND (topic_source='auto' OR topic_key IS NULL OR topic_key='')");
      for (const r of rows) { const r2 = upd.run(String(r.old_topic_key || '') || null, sid, Number(r.turn_no)); n += Number((r2 && r2.changes) || 0); }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { } return { ok: false, reason: String((e && e.message) || e) }; }
    setMeta('reflowedGen:' + sid, '');
    return { ok: true, restored: n };
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

// ==================== A（2026-09-29）：骨架(turn.summary)可读性升级 · 纯规则·零 LLM ====================
/** 纯应答行（无信息量）判定：整行只有"好/嗯/收到/继续/可以/明白/谢谢…"等语气词与标点。 */
const ACK_LINE_RE = /^(?:好|好的|好嘞|好呀|行|行的|嗯|恩|哦|噢|收到|了解|明白|明白了|懂了|可以|可以了|可以的|谢谢|感谢|多谢|辛苦|辛苦了|继续|继续吧|来吧|开始吧|ok|okay|yes|no|是|对|✅|👌|👍|🙏)[\s。.!！?,，~～…、]*$/i;
function isAckLine(s) { return ACK_LINE_RE.test(String(s == null ? '' : s).trim()); }
/** 是否含"实义"内容：有中日韩文字/字母数字词/书名号方括号等（纯标点/表情/空白视为无实义）。 */
function hasSubstantive(s) {
  const t = String(s == null ? '' : s);
  return /[\u4e00-\u9fff]/.test(t) || /[A-Za-z0-9]{2,}/.test(t) || /[【】《》「」]/.test(t);
}
/** 结论句关键词（助手侧优先取含这些词的行）。 */
const CONCLUSION_RE = /完成|已(?:经)?(?:修|改|建|加|写|做|发|部|同|上|下|通过)|修复|根因|结论|建议|通过|落地|生效|✅|已就绪|搞定/;
/** 清洗片段：去 markdown 标记（粗体/下划线/行内代码/标题符/行首列表符/表格竖线）与首尾孤立标点、括号。 */
function cleanSnippet(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/\*\*|__|_{2,}/g, '');            // 粗体/下划线
  t = t.replace(/`+/g, '');                        // 行内代码
  t = t.replace(/^\s*#{1,6}\s*/g, '');             // 行首 #
  t = t.replace(/(^|\s)#{1,6}\s*/g, ' ');          // 行中 # 标题符
  t = t.replace(/^\s*(?:[-*+•·>]\s+|\d{1,2}[.、)]\s+)/, '');   // 行首列表符/有序列表
  t = t.replace(/[|│]+/g, ' ');                    // 表格竖线
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/^[\s\u3000]*[，。、；：,.;:!！?？~～…·\-—\u2014"'"'）)\]】》」〉`|*#]+/, '');  // 首部孤立标点/括号
  t = t.replace(/[\s\u3000]*[，。、；：,.;:!！?？~～…·\-—\u2014"'"'（(【《「〈`|*#]+$/, '');      // 尾部孤立标点/括号
  return t.trim();
}
/** 纯占位内容（图片/视频/文件/截图标签）判定：无实义，不占位。 */
const PLACEHOLDER_RE = /^[\[（(【]?\s*(图片|图像|截图|照片|视频|音频|录音|文件|附件|image|img|photo|video|file|screenshot)\s*[\]）)】]?[\s。.!！?？]*$/i;
function isPlaceholder(s) { return PLACEHOLDER_RE.test(String(s == null ? '' : s).trim()); }
/** 用户侧取句：跳过纯应答行、纯占位(图片)行与 <8 字行 → 首个实义行；无则取整条最后实义句；仍无回退首行。 */
function pickUserSnippet(content) {
  const txt = String(content == null ? '' : content);
  const lines = txt.split('\n').map((x) => x.trim()).filter(Boolean);
  for (const ln of lines) { const c = cleanSnippet(ln); if (c.length >= 8 && !isAckLine(c) && !isPlaceholder(c) && hasSubstantive(c)) return c.slice(0, 80); }
  const sents = txt.split(/[。！？!?\n]+/).map((x) => x.trim()).filter(Boolean);
  for (let i = sents.length - 1; i >= 0; i--) { const c = cleanSnippet(sents[i]); if (c.length >= 4 && !isAckLine(c) && !isPlaceholder(c) && hasSubstantive(c)) return c.slice(0, 80); }
  return cleanSnippet(lines.find((x) => !isPlaceholder(x) && !isAckLine(cleanSnippet(x))) || lines[0] || '').slice(0, 80);
}
/** 助手侧取句：优先结论句（含关键词）；否则取末段实义句（开头常是"好/收到"语气词，不用开头）。
 *  过滤表格/代码噪声行（含 `|` 或清洗后 <6 字）。 */
function pickAssistantSnippet(text) {
  // 先剔除 markdown 表格行（竖线 ≥2）——表格内容做摘要可读性差。
  const raw = String(text == null ? '' : text);
  const noTable = raw.split('\n').filter((l) => ((l.match(/\|/g) || []).length) < 2).join('\n');
  const t = noTable.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const sents = t.split(/[。！？!?]+/).map((x) => x.trim()).filter(Boolean);
  const ok = (s) => { const c = cleanSnippet(s); return c.length >= 6 && !isAckLine(c) && !isPlaceholder(c) && hasSubstantive(c) && !/\|/.test(s); };
  for (const s of sents) { if (ok(s)) { const c = cleanSnippet(s); if (CONCLUSION_RE.test(c)) return c.slice(0, 80); } }
  for (let i = sents.length - 1; i >= 0; i--) { if (ok(sents[i])) return cleanSnippet(sents[i]).slice(0, 80); }
  // 兜底：剔除表格/竖线噪声行后再取
  const prose = t.split(/[。！？!?]+/).map((x) => x.trim()).filter((x) => x && !/\|/.test(x)).join('；');
  return (cleanSnippet(prose) || cleanSnippet(t)).slice(0, 80);
}
/** A：纯规则合成一轮骨架摘要（用户实义片段 → 助手结论/末段 + 〔工具名〕），总长 ≤120 字。**零 LLM**。
 *  工具名段先行预留预算，避免截断把工具名列表切成半截。 */
function composeTurnSummary(o) {
  try {
    const userPart0 = pickUserSnippet(o && o.userText);
    const asstPart = pickAssistantSnippet(o && o.assistantText);
    // 用户侧为纯应答/纯占位(图片)/极短（无信息量）时不占位（避免"好 → 结论…"这类噪声前缀）。
    const userPart = (isAckLine(userPart0) || isPlaceholder(userPart0) || cleanSnippet(userPart0).length < 4) ? '' : userPart0;
    let body = userPart;
    if (asstPart) body = body ? `${body} → ${asstPart}` : asstPart;
    if (!body) body = userPart0 || asstPart || '';
    const tools = [...new Set(((o && o.toolNames) || []).filter(Boolean))].slice(0, 8).join(',');
    const toolsPart = tools ? `〔${tools}〕` : '';
    const budget = Math.max(20, 120 - toolsPart.length);
    body = cleanSnippet(body.slice(0, budget));
    return (body + toolsPart).slice(0, 120);
  } catch { return ''; }
}

/** 重清洗一条已存骨架（幂等：clean(clean(x)) = clean(x)）。
 *  - 拆出行尾〔工具名〕；按 ` → ` 拆用户侧/助手侧；对每侧 cleanSnippet；
 *    用户侧为纯应答/纯占位(图片)/过短 → **不占位**（不写 `→`）。
 *  - 无 `→` 结构（单段）→ 整体清洗。
 *  - 不依赖 detail 重推导（防二次回填把上次结果当用户侧 → 产生 "X → X" 重复）。 */
function recleanTurnSummary(payload) {
  let s = String(payload == null ? '' : payload).trim();
  if (!s) return s;
  let toolsPart = '';
  const tm = s.match(/〔([^〕]*)〕\s*$/); if (tm) { toolsPart = `〔${tm[1]}〕`; s = s.slice(0, tm.index).trim(); }
  const parts = s.split(/\s*→\s*/);
  const budget = () => Math.max(20, 120 - toolsPart.length);
  if (parts.length === 1) {
    const c = cleanSnippet(s);
    if (!c) return '';
    if (isPlaceholder(c)) return ('图片轮（无文字）' + toolsPart).slice(0, 120);   // 纯占位轮：给中性标签，避免括号残留
    return (cleanSnippet(c.slice(0, budget())) + toolsPart).slice(0, 120);
  }
  let cu = cleanSnippet(parts[0] || '');
  let ca = cleanSnippet(parts.slice(1).join(' → ') || '');
  const keepU = !(isAckLine(cu) || isPlaceholder(cu) || cu.length < 4);
  const keepA = !(isAckLine(ca) || isPlaceholder(ca) || ca.length < 4);
  let body = keepU && keepA ? `${cu} → ${ca}` : (keepU ? cu : (keepA ? ca : (cu || ca)));
  if (!body && isPlaceholder(parts[0] || '')) body = '图片轮（无文字）';
  return (cleanSnippet(body.slice(0, budget())) + toolsPart).slice(0, 120);
}

/** B（2026-09-29）存量回填：按**当前最新清洗规则**重清洗已存 turn 骨架（纯规则，非 LLM）。
 *  - 只改 kind='turn' 的 payload（派生投影）；**绝不动任何其它 kind 的 payload/原文**。
 *  - 只 UPDATE，不 INSERT/DELETE → turn 行数/锚点严格不变；幂等（重复跑 changed→0）。
 *  - dryRun=true 只统计/预览。
 *  @returns {{ok:boolean, total:number, changed:number, skipped:number, samples:Array<{turnNo,old,neu}>}} */
function backfillTurnSummary(sessionId, opts = {}) {
  const ret = { ok: false, total: 0, changed: 0, skipped: 0, samples: [] };
  try {
    ensureInit();
    if (mode !== 'sqlite' || !db) { ret.reason = 'no-db'; return ret; }
    if (!hasNewCols) { ret.reason = 'no-cols'; return ret; }
    const sid = String(sessionId || ''); if (!sid) { ret.reason = 'no-sid'; return ret; }
    const dry = !!(opts && opts.dryRun);
    const turns = db.prepare("SELECT id, turn_no, payload FROM branch_event WHERE session_id=? AND kind='turn' ORDER BY turn_no ASC").all(sid);
    const upd = db.prepare("UPDATE branch_event SET payload=? WHERE id=?");
    for (const t of turns) {
      ret.total++;
      const raw = String(t.payload || '');
      let oldSum = raw, aborted = false;
      try { const o = JSON.parse(raw); if (o && typeof o === 'object') { oldSum = String(o.summary || ''); aborted = !!o.aborted; } } catch { }
      if (aborted) { ret.skipped++; continue; }                       // 中断轮保留原样
      const neu = recleanTurnSummary(oldSum);
      if (!neu || neu === oldSum) { ret.skipped++; continue; }
      ret.changed++;
      if (ret.samples.length < (Number(opts && opts.sample) || 10)) ret.samples.push({ turnNo: t.turn_no == null ? null : Number(t.turn_no), old: oldSum, neu });
      if (!dry) { try { upd.run(neu, t.id); } catch { } }
    }
    ret.ok = true;
    return ret;
  } catch (e) { ret.reason = String((e && e.message) || e); return ret; }
}

// ==================== G1/G2（2026-09-29）：跨实例只读折叠（主我看雷影的树 / 全局概览） ====================
/** 打开任意实例的 branch.db —— **只读连接**（readOnly:true），绝不开 WAL 写、绝不改其文件。
 *  事故教训：曾用文件级 Copy-Item 覆盖运行中库致 malformed → 这里只允许只读句柄。 */
function openReadonlyDb(dbPath) {
  try {
    const fsx = require('node:fs');
    if (!dbPath || !fsx.existsSync(dbPath)) return null;
    const sqlite = require('node:sqlite');
    const h = new sqlite.DatabaseSync(String(dbPath), { readOnly: true });
    try { h.exec('PRAGMA busy_timeout=3000;'); } catch { }
    return h;
  } catch { return null; }
}
function _dbCols(h) {
  try { return new Set(h.prepare('PRAGMA table_info(branch_event)').all().map((r) => String(r.name))); }
  catch { return new Set(); }
}
/** G1：读外部实例库并折叠其会话树（复用 sessionTree，ext 走该库句柄）。库不可读 → null（优雅降级）。 */
function sessionTreeFromDb(dbPath, sessionId, keepTurns = 200) {
  const h = openReadonlyDb(dbPath);
  if (!h) return null;
  try {
    const c = _dbCols(h);
    return sessionTree(sessionId, keepTurns, { db: h, hasNewCols: c.has('turn_no') && c.has('sub_seq') && c.has('origin') && c.has('topic_key') });
  } catch { return null; } finally { try { h.close(); } catch { } }
}
/** G1：从外部实例库折叠（只读）——供 project action=tree instance=<role> 复用同一渲染。 */
function foldFromDb(dbPath, sessionId, nearTurns = 200) {
  const h = openReadonlyDb(dbPath);
  if (!h) return null;
  try {
    const c = _dbCols(h);
    return fold(String(sessionId), nearTurns, { db: h, hasNewCols: c.has('turn_no') && c.has('sub_seq') && c.has('origin') && c.has('topic_key') });
  } catch { return null; } finally { try { h.close(); } catch { } }
}
/** G1：只读列出某实例库的**全部会话概览**（供 project action=overview）。库不可读 → null。 */
function listSessionsFromDb(dbPath) {
  const h = openReadonlyDb(dbPath);
  if (!h) return null;
  try {
    const c = _dbCols(h);
    const hasTopic = c.has('topic_key');
    const q = `SELECT session_id, COUNT(*) AS events,
        SUM(CASE WHEN kind='turn' THEN 1 ELSE 0 END) AS turns,
        SUM(CASE WHEN kind='todo' THEN 1 ELSE 0 END) AS todos,
        SUM(CASE WHEN kind='todo-done' THEN 1 ELSE 0 END) AS todosDone,
        MAX(ts) AS lastTs${hasTopic ? ", COUNT(DISTINCT CASE WHEN topic_key IS NOT NULL AND topic_key<>'' THEN topic_key END)" : ", 0"} AS branches
      FROM branch_event GROUP BY session_id ORDER BY lastTs DESC`;
    const rows = h.prepare(q).all();
    // v6.38（P4）：openTodos **与 fold 同源的去重集合差**（废弃 `todos - todosDone` 计数差）。
    //   计数差在有"重复 open / 孤立 done / done>open"时失真（实测 main 57/61、程序员 16/15）→ 少算甚至归零、隐藏真待办。
    //   一次查询取全部 todo/todo-done 行，按 session 分组用归一化键做集合差（库小，开销可忽略）。
    const openBySid = new Map();
    try {
      const tr = h.prepare("SELECT session_id, kind, payload FROM branch_event WHERE kind IN ('todo','todo-done')").all();
      const perSid = new Map();   // sid -> { open:Map(k->p), done:Set(k) }
      for (const r of (tr || [])) {
        const sid = String(r.session_id || ''); const p = String(r.payload || ''); if (!sid || !p) continue;
        let e = perSid.get(sid); if (!e) { e = { open: new Map(), done: new Set() }; perSid.set(sid, e); }
        const k = normTodoKey(p) || p;
        if (r.kind === 'todo-done') e.done.add(k); else if (!e.open.has(k)) e.open.set(k, p);
      }
      for (const [sid, e] of perSid) openBySid.set(sid, [...e.open.keys()].filter((k) => !e.done.has(k)).length);
    } catch { /* 兜底：下方回退计数差 */ }
    return (rows || []).map((r) => ({
      sessionId: String(r.session_id || ''), events: Number(r.events) || 0, turns: Number(r.turns) || 0,
      todos: Number(r.todos) || 0, todosDone: Number(r.todosDone) || 0,
      openTodos: openBySid.has(String(r.session_id || '')) ? openBySid.get(String(r.session_id || '')) : Math.max(0, (Number(r.todos) || 0) - (Number(r.todosDone) || 0)),
      branches: Number(r.branches) || 0, lastTs: Number(r.lastTs) || 0,
    }));
  } catch { return null; } finally { try { h.close(); } catch { } }
}
/** G1/G2：角色英文名 → 雷影目录名（与 ROL-2/ROL-6 一致；'main'/空 = 主引擎自身）。 */
const INSTANCE_DIRS = { main: null, programmer: '程序员', designer: '美工', writer: '文案', tester: '测试', researcher: '研究员', sales: '销售' };
function instanceDbPath(role, opts = {}) {
  const r = String(role || '').trim();
  if (!r || r === 'main') return null;   // 主引擎自身（用本实例单例库）
  // 防路径穿越：instance 只接受单个目录名（禁分隔符/上级引用），只读也从严。
  if (/[\\/]|\.\./.test(r)) return null;
  const dir = Object.prototype.hasOwnProperty.call(INSTANCE_DIRS, r) ? INSTANCE_DIRS[r] : r;   // 未登记则按原样当目录名
  if (!dir) return null;
  const path = require('node:path');
  const root = (opts && opts.root) || 'F:\\leizai\\雷影';
  return path.join(root, dir, 'data', 'branch.db');
}

module.exports = {
  KINDS, REF, init, close, enabled, append, writeTurn, flushTurn, fold, hasEvent, hasOpenPrefix, findSimilarOpenPrefix, normPrefixKey, normBodyKey, normPrefixBodyKey, normTodoKey,
  resolveOpenPrefixPayload, resolveOpenTodoPayload,
  linkEvent, trace, promote, compact, maybeAutoCompact,
  extractLedgerKeyEntries, seedDecisionsFromLedger, maybeSeedFromLedger,
  setTurnTopic, setRangeTopic, backfillTurnNo, searchEvents,
  autoAssignTopic, sessionTree, normalizeTopicKey, TOPIC_ALIASES, _branchTerms, _charBigrams, _jaccard,
  sessionTreeFromDb, listSessionsFromDb, foldFromDb, instanceDbPath, INSTANCE_DIRS,
  reflowGen, reflowUndo, getMeta, setMeta, _reflowEligible,
  composeTurnSummary, backfillTurnSummary, recleanTurnSummary, isAckLine, hasSubstantive, cleanSnippet, isPlaceholder,   // A/B（2026-09-29）骨架可读性升级（纯规则）
  mode: () => mode, dbPath, dbFile: () => resolveFile(),
  hasNewCols: () => hasNewCols, hasTopicSource: () => hasTopicSource,
};
