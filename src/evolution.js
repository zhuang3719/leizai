'use strict';
// 雷仔 · 进化引擎（propose-not-apply，源自 Prime Agent 的 RLM harness 机制）
// 雷仔从不直接改自己的“基因组”，而是：
//   提出提案(propose) → 记录版本快照 → 批准(approve)生效 → 全部留档、可回滚(rollback)
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ROOT, DATA_DIR, load: loadConfig } = require('./config');
const memory = require('./memory');
const { HARNESS_PATH } = require('./prompt');

const EVO_DIR = path.join(DATA_DIR, 'evolution');
const PROPOSAL_DIR = path.join(EVO_DIR, 'proposals');
const VERSION_DIR = path.join(EVO_DIR, 'versions');
const JOURNAL = path.join(EVO_DIR, 'journal.md');
const SYSTEM_PATH = path.join(DATA_DIR, 'prompts', 'system.md');

function ensure() {
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  fs.mkdirSync(VERSION_DIR, { recursive: true });
  if (!fs.existsSync(JOURNAL)) fs.writeFileSync(JOURNAL, '# 雷仔进化日志\n\n| 时间 | 状态 | 目标 | 提案 |\n|---|---|---|---|\n', 'utf8');
}

function stamp() { return new Date().toISOString(); }

function targetPath(target) {
  if (target === 'system.md') return SYSTEM_PATH;
  if (target === 'harness') return HARNESS_PATH;   // 补充态（可进化，基础基因组保持稳定）
  const m = /^(memory|skill):(.+)$/.exec(target);
  if (m) {
    if (m[1] === 'skill') return memory.skillFile(m[2]); // 技能包优先 SKILL.md
    return memory.fileOf(m[1], m[2]);
  }
  throw new Error(`未知进化目标: ${target}`);
}

function journal(entry) {
  ensure();
  fs.appendFileSync(JOURNAL, `| ${entry.ts} | ${entry.status} | ${entry.target} | ${entry.title.replace(/\|/g, '/')} |\n`, 'utf8');
}

/**
 * 运行确定性质量门禁（对齐 Prime Agent 的 deterministic quality gates）。
 * gate 为非空的 shell 命令；退出码 0 视为通过。超时/崩溃视为失败。
 * 通过后把 bounded 输出带回给下一次协商（此处以错误信息形式回给调用方）。
 */
async function runGate(gate, timeoutMs = 120000) {
  if (!gate || !String(gate).trim()) return { pass: true, code: 0, out: '(未配置门禁)' };
  const shell = process.platform === 'win32'
    ? (process.env.COMSPEC ? 'cmd' : 'powershell.exe')
    : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['/c', String(gate)]
    : ['-c', String(gate)];
  return new Promise((resolve) => {
    try {
      execFile(shell, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? ((typeof err.code === 'number') ? err.code : 1) : 0;
        resolve({ pass: code === 0, code, out: (stdout || '').slice(0, 4000), err: (stderr || '').slice(0, 4000) });
      });
    } catch (e) {
      resolve({ pass: false, code: 1, out: '', err: `门禁启动失败: ${e.message}` });
    }
  });
}

/** 整文件骤缩护栏：防"误把 content 当追加段"导致整文件被覆盖丢失。
 *  仅对"提示词类全文文件"生效（harness / system.md）；memory/skill 目标不套用（技能包覆写可能正常）。
 *  判定：新内容显著小于旧内容（默认 <50%）→ 视为疑似误覆盖，拒绝并要求改用 patch。
 *  @param {string} target 进化目标
 *  @param {string} oldContent 现有全文
 *  @param {string} newContent 拟写入全文
 *  @param {{allowShrink?:boolean,minRatio?:number}} [opts] allowShrink=显式逃生舱；minRatio=阈值(默认0.5)
 *  @returns {void} 通过则无异常；疑似误覆盖则抛错
 */
function assertNoShrink(target, oldContent, newContent, opts = {}) {
  const fullFileTargets = new Set(['harness', 'system.md']);
  if (!fullFileTargets.has(target)) return;          // 只对提示词全文文件生效
  if (!oldContent || oldContent.length === 0) return; // 新文件/空文件不拦
  const allowShrink = !!(opts && opts.allowShrink);
  const ratio = (opts && opts.minRatio != null) ? opts.minRatio : 0.5;
  if (!allowShrink && newContent.length < oldContent.length * ratio) {
    throw new Error(
      `【骤缩护栏】target=${target} 的新内容(${newContent.length} 字符)不足旧内容(${oldContent.length} 字符)的 ${Math.round(ratio * 100)}%，` +
      `疑似"把 content 当追加段"导致整文件被覆盖丢失。\n` +
      `· 若要追加规则：请改用 patch: { old: "<目标文件中精确的一段原文>", new: "<改后内容>" }；\n` +
      `· 若确要大幅精简：传 content 为**完整新文件全文**，并显式传 allowShrink: true。`
    );
  }
}

/**
 * 提出进化提案。
 * @param {object} p {target, title, rationale, content?, patch?:{old,new}, audit?, allowShrink?, minRatio?}
 *   audit {trigger?, blastRadius?, validation?, confidence?, intent?} —— Capsule式审计：
 *     trigger: 触发信号（如"重复收到同错误/性能指标"）
 *     intent: 演进意图 repair/optimize/innovate/explore
 *     blastRadius: 风险范围 {files, lines} 或描述字符串
 *     validation: 验证结果（如何确认改动正确）
 *     confidence: 置信度 0~1
 * @returns 提案对象
 */
function propose(p) {
  ensure();
  // Pro 门禁（soft-gate）：自我进化属 Pro；Lite 态拒绝。gate 绝不 throw，异常一律放行。
  { let _pg = { allow: false, tier: 'lite', reason: 'gate-unavailable(fail-safe-lite)' }; try { _pg = require('./pro/gate').check('evolution', { op: 'propose' }); } catch { } 
    if (_pg.allow === false) throw new Error(`自我进化属 Pro 能力（当前 ${_pg.tier} 档｜${_pg.reason}），升级 Pro 后可用`); }
  const target = p.target;
  const file = targetPath(target);
  const oldContent = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let newContent = p.content;
  if (!newContent && p.patch) {
    const { old, new: nw } = p.patch;
    if (!old || nw === undefined) throw new Error('patch 需要 {old, new}');
    const idx = oldContent.indexOf(old);
    if (idx < 0) throw new Error('patch 未能在目标中找到匹配原文（内容可能已被修改，请改为提供完整 content）');
    newContent = oldContent.slice(0, idx) + nw + oldContent.slice(idx + old.length);
  }
  if (newContent === undefined) throw new Error('需要 content 或 patch.{old,new}');
  if (newContent === oldContent) throw new Error('提案内容与现状完全一致，没有变化');
  // —— 整文件骤缩护栏（防"误把 content 当追加段"导致整文件被覆盖；对 patch 路径同样生效）——
  assertNoShrink(target, oldContent, newContent, { allowShrink: !!p.allowShrink, minRatio: p.minRatio });

  const id = `${stamp().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const proposal = {
    id, ts: stamp(), status: 'pending',
    target, title: String(p.title || '未命名改进').slice(0, 120),
    rationale: String(p.rationale || '').slice(0, 2000),
    // Capsule 式审计：触发信号/意图/风险范围/验证结果/置信度（可选，复盘与回滚前评估用）
    audit: {
      trigger: String((p.audit && p.audit.trigger) || '').slice(0, 1000),
      intent: String((p.audit && p.audit.intent) || 'auto').slice(0, 20),
      blastRadius: (p.audit && p.audit.blastRadius) || null,
      validation: String((p.audit && p.audit.validation) || '').slice(0, 1000),
      confidence: p.audit && typeof p.audit.confidence === 'number' ? Math.max(0, Math.min(1, p.audit.confidence)) : null,
    },
    oldContent, newContent,
    hashBefore: hashOf(oldContent), hashAfter: hashOf(newContent),
    gate: String(p.gate || '').slice(0, 2000),           // 可选：确定性质量门禁（shell 命令）
    gateTimeoutMs: p.gateTimeoutMs || 120000,
    allowShrink: !!p.allowShrink,                        // 骤缩护栏逃生舱（审计用）
    minRatio: (p.minRatio != null ? p.minRatio : 0.5),   // 骤缩护栏阈值（审计用）
    appliedAt: null, auto: !!p.auto,
  };
  fs.writeFileSync(path.join(PROPOSAL_DIR, `${id}.json`), JSON.stringify(proposal, null, 2), 'utf8');
  journal({ ts: proposal.ts, status: 'proposed', target, title: proposal.title });
  return proposal;
}

/**
 * 批准并应用：先跑质量门禁（若配置/指定），通过后留版本快照，再写入新内容。
 * 门禁失败 → 提案停留在 pending 并记录 gateError，抛出带门禁输出的错误供调用方修复。
 */
async function approve(id, { auto = false, gate, gateTimeoutMs } = {}) {
  ensure();
  // Pro 门禁（soft-gate）：进化生效属 Pro；Lite 态拒绝。gate 绝不 throw，异常一律放行。
  { let _pg = { allow: false, tier: 'lite', reason: 'gate-unavailable(fail-safe-lite)' }; try { _pg = require('./pro/gate').check('evolution', { op: 'approve' }); } catch { } 
    if (_pg.allow === false) throw new Error(`自我进化（生效）属 Pro 能力（当前 ${_pg.tier} 档｜${_pg.reason}），升级 Pro 后可用`); }
  const p = load(id);
  if (p.status === 'applied') return p;
  if (p.status === 'rejected') throw new Error('已被否决，不可批准（可重新提议）');
  const gateCmd = gate !== undefined ? gate : (p.gate || loadConfig().evolutionGate || '');
  const tms = gateTimeoutMs || p.gateTimeoutMs || 120000;
  if (gateCmd && String(gateCmd).trim()) {
    const g = await runGate(gateCmd, tms);
    if (!g.pass) {
      p.status = 'pending'; p.gateError = `门禁未通过（exit=${g.code}）\n${(g.err || '').slice(0, 2000)}\n${(g.out || '').slice(0, 1500)}`;
      fs.writeFileSync(path.join(PROPOSAL_DIR, `${id}.json`), JSON.stringify(p, null, 2), 'utf8');
      journal({ ts: stamp(), status: 'gate-failed', target: p.target, title: p.title });
      throw new Error(`进化被质量门禁拦截：${p.gateError}`);
    }
  }
  // —— 落盘前再校验一次骤缩护栏（加固：防绕过 propose 直接 approve / 旧提案）——
  try {
    assertNoShrink(p.target, p.oldContent || '', p.newContent || '', { allowShrink: !!p.allowShrink, minRatio: p.minRatio });
  } catch (e) {
    p.status = 'pending'; p.shrinkError = e.message;
    fs.writeFileSync(path.join(PROPOSAL_DIR, `${id}.json`), JSON.stringify(p, null, 2), 'utf8');
    journal({ ts: stamp(), status: 'shrink-blocked', target: p.target, title: p.title });
    throw e;
  }
  const file = targetPath(p.target);
  const snapshot = {
    id: `${id}-v1`, ts: stamp(), target: p.target,
    content: p.oldContent, hash: p.hashBefore,
  };
  fs.writeFileSync(path.join(VERSION_DIR, `${id}.json`), JSON.stringify(snapshot, null, 2), 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, p.newContent, 'utf8');
  p.status = 'applied'; p.appliedAt = stamp(); p.auto = p.auto || auto;
  p.gateError = undefined;
  fs.writeFileSync(path.join(PROPOSAL_DIR, `${id}.json`), JSON.stringify(p, null, 2), 'utf8');
  journal({ ts: p.appliedAt, status: p.auto ? 'auto-applied' : 'applied', target: p.target, title: p.title });
  return p;
}

function reject(id) {
  const p = load(id);
  if (p.status !== 'pending') throw new Error('仅待决提案可被否决');
  p.status = 'rejected'; p.rejectedAt = stamp();
  fs.writeFileSync(path.join(PROPOSAL_DIR, `${id}.json`), JSON.stringify(p, null, 2), 'utf8');
  journal({ ts: p.rejectedAt, status: 'rejected', target: p.target, title: p.title });
  return p;
}

/** 回滚：以版本快照恢复内容。 */
function rollback(id) {
  ensure();
  const p = load(id);
  const verFile = path.join(VERSION_DIR, `${id}.json`);
  if (!fs.existsSync(verFile)) throw new Error('该提案没有版本快照，无法回滚');
  const snap = JSON.parse(fs.readFileSync(verFile, 'utf8'));
  const file = targetPath(p.target);
  // 当前内容已不是本提案产物则拒绝（防止乱回滚）
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (hashOf(cur) !== p.hashAfter) throw new Error('目标自应用后又被改动过，为安全起见已拒绝回滚');
  fs.writeFileSync(file, snap.content, 'utf8');
  p.status = 'reverted'; p.revertedAt = stamp();
  fs.writeFileSync(path.join(PROPOSAL_DIR, `${id}.json`), JSON.stringify(p, null, 2), 'utf8');
  journal({ ts: p.revertedAt, status: 'rolled-back', target: p.target, title: p.title });
  return p;
}

function load(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROPOSAL_DIR, `${id}.json`), 'utf8'));
  } catch {
    throw new Error(`提案不存在: ${id}`);
  }
}

function list() {
  ensure();
  return fs.readdirSync(PROPOSAL_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PROPOSAL_DIR, f), 'utf8')))
    .sort((a, b) => (b.ts > a.ts ? 1 : -1));
}

function feed(limit = 80) {
  ensure();
  const lines = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter((l) => l.startsWith('|')).slice(1, limit + 1);
  return lines.map((l) => {
    const [_, ts, status, target, title] = l.split('|').map((s) => s.trim());
    return { ts, status, target, title };
  });
}

function hashOf(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

module.exports = { propose, approve, reject, rollback, list, feed, load, hashOf, runGate, EVO_DIR };
