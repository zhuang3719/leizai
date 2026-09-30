'use strict';
// 雷仔 · 记忆库（data/memory/*.md）与技能库（data/skills/*）
// 技能两种形态：文档技能 data/skills/<slug>.md；可执行技能包 data/skills/<slug>/（SKILL.md + main.py）
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, DATA_DIR, load } = require('./config');
const skills = require('./skills');

const MEM_DIR = path.join(DATA_DIR, 'memory');
const SKILL_DIR = path.join(DATA_DIR, 'skills');

function ensure() {
  fs.mkdirSync(MEM_DIR, { recursive: true });
  fs.mkdirSync(SKILL_DIR, { recursive: true });
}

/** 解析并剥离元数据标签行（@project: ...）：返回 { project, clean }。标记只归档展示，不进入稳定前缀。 */
function extractProject(raw) {
  const { project, clean } = stripMeta(raw);
  return { project, clean };
}

/** v3.1 H1 · 元数据统一剥离：返回 { project, alias, clean, display }。
 *  - project: 头部 `@project: xxx` 行的值；
 *  - alias  : 头部 `@alias: a, b` 行的值（逗号/顿号分隔的别名词串）；
 *  - clean  : 去掉 @project/@alias 行后的正文（保留标题行，供 read() 展示）；
 *  - display: clean 再去掉 `#` 开头的标题行（供 preview/snippet/索引 展示，去重标题与名字）。
 *  **红线：别名只进检索域，绝不进展示**；四个展示落点一律基于本函数。 */
function stripMeta(raw) {
  let project = '', alias = '';
  let t = String(raw || '');
  const mp = t.match(/^@project:\s*(.+)\s*$/m);
  if (mp) { project = mp[1].trim(); t = t.replace(/^@project:\s*.+\s*$/m, ''); }
  const ma = t.match(/^@alias:\s*(.+)\s*$/m);
  if (ma) { alias = ma[1].trim(); t = t.replace(/^@alias:\s*.+\s*$/m, ''); }
  const clean = t.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trim();
  const display = clean.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { project, alias, clean, display };
}

/** 单条原文的别名串（H1 别名只进检索域）。 */
function extractAlias(raw) { return stripMeta(raw).alias; }

/** 别名串 → 去重后的别名词数组（逗号/顿号/分号/空格分隔）。 */
function aliasList(alias) {
  return [...new Set(String(alias || '').split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean))];
}

/** v3.1 文本归一化（bigram 用）：小写、去空白与标点，仅留中日韩/字母/数字。 */
function normText(x) {
  return String(x || '').toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '');
}

/** v3.1 bigram 切片：归一化文本的相邻二字片；另附 ≥3 字符的 ASCII 词（cache/token 等英文词整词可命中）。
 *  v3.2 修 P0-数字成片：**≥3 位连续数字整体成 token**（同英文处理），其内部不再切 bigram ——
 *  避免 `3460` 被切成 `34/46/60` 与日期(`20260913` 等)碰撞而错指（红队 A2）。 */
function gramsOf(x) {
  const t = normText(x);
  const out = [];
  for (let i = 0; i + 1 < t.length; i++) {
    const a = t[i], b = t[i + 1];
    if (a >= '0' && a <= '9' && b >= '0' && b <= '9') continue;   // v3.2：纯数字 bigram 丢弃（由数字 token 取代）
    out.push(a + b);
  }
  const toks = String(x || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  for (const tk of toks) out.push(tk);
  return out;
}

/** v3.2：数字 token（≥3 位纯数字）识别，用于命中加权。 */
function isNumToken(g) { return /^\d{3,}$/.test(g); }

/** v3.2 修 P0-精确原串奖励：查询归一化后连续出现于记忆 → 显著、**不封顶**的 bonus。
 *  - 命中 clean 正文（归一化后含子串）：base + perChar×长度（长串更高，不封顶）；
 *  - 仅命中 名字/别名（原文小写包含）：较小 bonus，覆盖"查询即专名"场景；
 *  - 长度保护：query 归一化后 <2 字不给 bonus（避免单字泛词乱加分）。 */
const PHRASE_BASE = 0.6, PHRASE_PER_CHAR = 0.08, PHRASE_NAME_BASE = 0.3, PHRASE_NAME_PER_CHAR = 0.05;
const PHRASE_MIN_LEN = 3;   // 正文连续命中需 ≥3 字（2 字泛词几乎人人命中，加分=噪声）
function phraseBonusOf(entry, qNorm, qRawLower) {
  const L = qNorm ? qNorm.length : 0;
  if (L < 2) return 0;
  const cleanNorm = entry._cleanNorm || (entry._cleanNorm = normText(entry.clean || ''));
  if (L >= PHRASE_MIN_LEN && cleanNorm.includes(qNorm)) return PHRASE_BASE + PHRASE_PER_CHAR * L;
  const qr = String(qRawLower || '').trim();
  if (qr.length >= 2) {
    if (String(entry.name || '').toLowerCase().includes(qr)) return PHRASE_NAME_BASE + PHRASE_NAME_PER_CHAR * qr.length;
    if ((entry.aliases || []).some((a) => String(a).toLowerCase().includes(qr))) return PHRASE_NAME_BASE + PHRASE_NAME_PER_CHAR * qr.length;
  }
  return 0;
}

// ———— 会话上下文归档（"静默"保存被压缩的旧回合，可随时召回，不进稳定前缀） ————
// 存储实现已迁移到 src/archiveStore.js（SQLite 主路径 + JSONL 回退，含世代 gen/seq/kind/分级裁剪）。
// 这里仅做签名完全一致的转发，runtime/工具/HTTP 层零改动。
const archiveStore = require('./archiveStore');
archiveStore.init();
const ARCHIVE_DIR = archiveStore.ARCHIVE_DIR();   // 兼容旧导出（字符串，默认目录）

function archiveSave(sessionId, messages, opts = {}) { return archiveStore.save(sessionId, messages, opts); }
/** v3.1 Layer C：归档检索埋点 —— 零命中/低置信 → miss_log（kind='archive'）。取数用，可 config 关。 */
function archiveSearch(sessionId, query, limit = 5, opts = {}) {
  let hits = archiveStore.search(sessionId, query, limit, opts);
  // v3.1 C⁺ 兜底：对话层零命中且未显式指定层 → 回退证据层（保持旧召回率，仅"真 miss"才记账）
  try {
    if (!hits.length && !opts.include && load().archiveToolFallback !== false) {
      hits = archiveStore.search(sessionId, query, limit, { include: 'all' });
    }
  } catch { }
  try {
    if (load().archiveMissLog !== false) {
      const top = hits.length ? (Number(hits[0].score) || 0) : 0;
      const low = Number(load().archiveMissLowConf);
      const thr = Number.isFinite(low) ? low : 0.5;
      if (!hits.length) logMiss(query, 'archive', 0, 'zero-hit');
      else if (top < thr) logMiss(query, 'archive', Math.round(top * 100) / 100, 'low-confidence');
    }
  } catch { }
  return hits;
}
function archiveRead(sessionId, limit = 500, offset = 0) { return archiveStore.readPage(sessionId, limit, offset); }
function archiveCount(sessionId) { return archiveStore.count(sessionId); }
function archiveErase(sessionId) { return archiveStore.erase(sessionId); }
function archiveClear(sessionId) { return archiveStore.clear(sessionId); }

function slug(name) {
  return name.trim().replace(/[\\/:*?"<>|#\[\]]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'untitled';
}

const READONLY_COLLECTIONS = new Set(['doc', 'script']);
function assertWritable(kind) {
  if (READONLY_COLLECTIONS.has(kind)) {
    throw new Error(`集合 "${kind}" 为只读（用于检索既有方案/脚本），不支持写入/删除`);
  }
}
function fileOf(kind, name) {
  assertWritable(kind);   // doc/script 只读 → 明确报错（不静默返回 null）
  return path.join(kind === 'memory' ? MEM_DIR : SKILL_DIR, slug(name) + '.md');
}

/** 技能当前可编辑文件（包 SKILL.md 优先）。 */
function skillFile(name) {
  return skills.currentFile(name) || fileOf('skill', name);
}

function list(kind) {
  ensure();
  // 摘要（H1 落点①）：统一走 stripMeta 的 display（不含 @project/@alias 与 # 标题行），正文前 90 字符
  const preview = (raw) => stripMeta(raw).display.split('\n').join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  if (kind === 'memory') {
    const dir = MEM_DIR;
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const file = path.join(dir, f);
        const raw = fs.readFileSync(file, 'utf8');
        const { project, clean } = extractProject(raw);
        const title = (clean.match(/^#\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
        return { name: f.replace(/\.md$/, ''), title, size: raw.length, mtime: fs.statSync(file).mtimeMs, project, preview: preview(clean) };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
  // 技能：文档 + 包（同名去重，可执行包优先）
  const out = [];
  const byName = new Map();
  for (const entry of fs.readdirSync(SKILL_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = path.join(SKILL_DIR, entry.name);
      const raw = fs.readFileSync(file, 'utf8');
      const { project, clean } = extractProject(raw);
      const title = (clean.match(/^#\s*(.+)$/m) || [])[1] || entry.name.replace(/\.md$/, '');
      const key = entry.name.replace(/\.md$/, '');
      const cur = byName.get(key);
      if (!cur || !cur.pkg) byName.set(key, { name: key, title, size: raw.length, mtime: fs.statSync(file).mtimeMs, pkg: false, project, preview: preview(clean) });
    } else if (entry.isDirectory()) {
      const md = path.join(SKILL_DIR, entry.name, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      const raw = fs.readFileSync(md, 'utf8');
      const { project, clean } = extractProject(raw);
      const title = (clean.match(/^#\s*(.+)$/m) || [])[1] || entry.name;
      const mp = path.join(SKILL_DIR, entry.name, 'main.py');
      const record = {
        name: entry.name, title,
        size: raw.length + (fs.existsSync(mp) ? fs.statSync(mp).size : 0),
        mtime: fs.statSync(md).mtimeMs, pkg: fs.existsSync(mp), project, preview: preview(clean),
      };
      byName.set(entry.name, record); // 包优先于同名 .md 文档
    }
  }
  out.push(...byName.values());
  return out.sort((a, b) => b.mtime - a.mtime);
}

function read(kind, name) {
  assertWritable(kind);
  // H1 落点②：统一走 stripMeta（别名绝不进展示；content 为 clean，保留标题行便于阅读）
  if (kind === 'memory') {
    const file = fileOf(kind, name);
    if (!fs.existsSync(file)) return null;
    const { project, alias, clean } = stripMeta(fs.readFileSync(file, 'utf8'));
    return { name: slug(name), content: clean, project, alias };
  }
  const file = skills.currentFile(name) || fileOf('skill', name);
  if (!fs.existsSync(file)) return null;
  const { project, alias, clean } = stripMeta(fs.readFileSync(file, 'utf8'));
  return { name: slug(name), content: clean, project, alias };
}

/**
 * 自动重建全局记忆总索引（workspace/记忆索引.md）。
 * 在每次保存记忆后调用：扫描 data/memory/*.md，按规则分类，重建索引文件。
 * 设计动机：原索引靠手工维护会过期/漏收（曾 86 条却只收录 52 条、从某日不再更新），
 * 导致"防忘"机制引用的索引本身残缺。改为 save() 时自动重建，让索引永远与环境一致。
 * 失败不抛异常（不影响记忆保存本身），只在控制台提示。
 */
const _IDX_CATS = [
  { title: '自我认知（self:*，认识雷仔自己）', test: (n) => n.startsWith('self') },
  { title: '主人相关（懂主人）', test: (n) => /主人|身份|档案|用户鼓励|协作/.test(n) },
  { title: '员工体系（我的团队）', test: (n) => /员工|子智能体|专精|成本优化师|经验-子智能体/.test(n) },
  { title: '开源淘金 / 成本优化（备战储备）', test: (n) => /开源|成本优化|MCP|学习储备/.test(n) },
  { title: '技术 / bug / 引擎', test: (n) => /bug|进程资源|引擎|配置-|单回合|修复|重启|归档规则/.test(n) },
  { title: '约定 / 规则 / 教训', test: (n) => /教训|暗号约定|决策-|自动交接|归档机制|归档|防忘|自我觉察|盘点|机制-|建多养少|系统被外部|工作区|能力边界|记忆审计|压缩摘要|codex/.test(n) },
  { title: '项目 / 其他', test: () => true },
];

// 缓存：按 (文件数+尺寸) 判断是否需要重建，避免每次 save 都全量扫描重写
const _idxCache = { key: '', mtimeMs: '' };
function _catOf(name) {
  for (const c of _IDX_CATS) if (c.test(name)) return c.title;
  return '项目 / 其他';
}
function rebuildIndex() {
  try {
    // M3/清单 14：免 statSync——复用 SEARCH_CACHE 的文件表（name + mtime），单一 mtime 源
    const data = getSearchData('memory');
    const files = [...data.keys()].map((n) => n + '.md').sort();
    const key = [...data.entries()].map(([n, e]) => n + ':' + e.mtime).sort().join('|');
    if (_idxCache.key === key && fs.existsSync(path.join(ROOT, 'workspace', '记忆索引.md'))) return;
    _idxCache.key = key;

    const groups = new Map();
    for (const f of files) {
      const name = f.replace(/\.md$/, '');
      const c = _catOf(name);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(name);
    }
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const out = [];
    out.push('# 雷仔 · 全局记忆总索引（自动同步版）', '');
    out.push('> 跨会话复用地图：任何会话先查这里，知道有哪些记忆、在哪个文件，用 recall_memory <关键词> 或读 data/memory/<名>.md 调取。');
    out.push(`> 更新：${ts} · 共 ${files.length} 条记忆 · 由 memory.save() 自动重建`, '');
    for (const c of _IDX_CATS) {
      const items = groups.get(c.title);
      if (!items || !items.length) continue;
      out.push(`## ${c.title}（${items.length}条）`);
      for (const it of items.sort()) out.push(`- ${it}`);
      out.push('');
    }
    out.push('## 使用提示', '');
    out.push('- 本索引由 memory.save() 每次保存记忆后自动重建，无需手动维护。');
    out.push('- 任何课题会话：先 read_file workspace/记忆索引.md 看有什么 → recall_memory 调详情。');
    const dir = path.join(ROOT, 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '记忆索引.md'), out.join('\n'), 'utf8');
  } catch (e) {
    try { console.error('[memory] 重建记忆索引失败（不影响记忆保存）:', e.message); } catch { }
  }
}
/** 清单 14：索引重建改异步（不阻塞 save 返回） */
function scheduleRebuildIndex() {
  try { setImmediate(() => { try { rebuildIndex(); } catch { } }); }
  catch { try { rebuildIndex(); } catch { } }
}

/**
 * 保存记忆/技能。
 * kind=skill 且 opts.code 非空 → 保存为可执行技能包（SKILL.md + main.py）。
 */
/** 记忆查重软护栏：保存新记忆前，检查是否与已有记忆名高度相似（共享≥4字符的连续中文关键词）。
 *  非阻断——只在确实高度重合时返回提醒，引导合并，避免"同一事实散多文件"冗余。
 *  设计原则：宁可漏报也不误报（只对确实长的连续关键词重叠才提示，避免正常新增被误伤）。 */
function findSimilarMemory(name) {
  try {
    const target = String(name || '');
    if (target.trim().length < 4) return null;   // 太短不判断（易误报）
    // 清单 13：复用检索缓存的文件表（不再 readdirSync）；H3：target_ 与 slug 口径统一
    const self = slug(target);
    const files = [...getSearchData('memory').keys()].filter((f) => f !== self);
    const target_ = slug(target).replace(/\s+/g, '');
    let best, bestScore = 0;
    for (const f of files) {
      const cand = String(f).replace(/\.md$/, '').replace(/\s+/g, '');
      if (cand.length < 4) continue;
      // 连续公共子串（≥4字符）即视为高度相关
      for (let len = Math.min(4, target_.length); len >= 4; len--) {
        for (let i = 0; i + len <= target_.length; i++) {
          const sub = target_.slice(i, i + len);
          if (sub.length >= 4 && cand.includes(sub)) {
            const score = sub.length;
            if (score > bestScore) { bestScore = score; best = cand; }
            i = target_.length; // 找到该长度最长匹配后跳过
            break;
          }
        }
      }
    }
    return bestScore >= 4 ? best : null;
  } catch (e) {
    return null; // 查重失败不影响保存
  }
}

function save(kind, name, content, opts = {}) {
  ensure();
  assertWritable(kind);
  const k = kind === 'skill' ? 'skill' : 'memory';

  if (kind === 'skill' && opts.code && String(opts.code).trim()) {
    invalidateSearchCache('skill');   // 清单 11/§L5：技能包写路径置脏
    return skills.savePackage(name, opts.description || '', content, opts.code, { project: opts.project });
  }
  // V3·治本收尾（2026-09-23）：self 前缀防护——`self`/`self:xxx` 开头但**非** `self-<主题>` 的 name
  //   一律改走 appendSelfSection（归入主题文件），杜绝 `selfXXX.md` 单条碎片。
  if (kind === 'memory' && /^self(?!-)/.test(String(name == null ? '' : name).trim())) {
    const f = appendSelfSection(name, content);
    return `${f}\n【self 归类】name 以 self 开头且非 self- 主题前缀 → 已并入主题文件（未新建单条文件）。`;
  }
  // 清单 8：save_memory 的 aliases 参数（数组或逗号串）→ 头部 @alias 行
  const newAliases = aliasList(Array.isArray(opts.aliases) ? opts.aliases.join(',') : opts.aliases);
  const file = fileOf(kind, name);
  const tag = opts.project ? `@project: ${opts.project}\n\n` : '';
  const aliasTag = newAliases.length ? `@alias: ${newAliases.join(', ')}\n\n` : '';
  // 记忆查重软护栏：保存前检测近似已有记忆，非阻断，仅返回提醒
  let dedupHint = '';
  if (kind === 'memory') {
    const sim = findSimilarMemory(name);
    if (sim) dedupHint = `\n\n【查重提醒】疑似与已有记忆『${sim}』主题相近（共享≥4字符关键词），若非新事实可考虑合并（用 save_memory 写到同名会追加节）。`;
  }
  // 同名记忆：追加新节而不是整体覆盖（保留历史）
  if (kind === 'memory' && fs.existsSync(file)) {
    let old = fs.readFileSync(file, 'utf8');
    // §L2：同名追加时 aliases 合并去重（旧头部 @alias ∪ 新 aliases，去重后重写该行）
    if (newAliases.length) {
      const oldAlias = aliasList((old.match(/^@alias:\s*(.+)\s*$/m) || [])[1] || '');
      const merged = [...new Set([...oldAlias, ...newAliases])];
      const line = `@alias: ${merged.join(', ')}`;
      if (/^@alias:\s*.+\s*$/m.test(old)) old = old.replace(/^@alias:\s*.+\s*$/m, line);
      else {
        const hm = old.match(/^(#\s*.+)$/m);
        if (hm) old = old.replace(hm[1], `${hm[1]}\n${line}`); else old = `${line}\n${old}`;
      }
      fs.writeFileSync(file, old, 'utf8');
    }
    fs.appendFileSync(file, `\n\n## ${new Date().toISOString().slice(0, 10)}\n${content.trim()}\n`, 'utf8');
  } else {
    fs.writeFileSync(file, `# ${name.trim()}\n\n${tag}${aliasTag}${content.trim()}\n`, 'utf8');
  }
  // 清单 11：save 增量更新缓存与倒排（不整库重建）；若缓存已脏则保持脏（下次重建即含新内容）
  updateCacheEntry(k, name);
  // V3：写入 self-*.md 后段级索引失效（reflect 写自我认知 → 下次检索自动重算）
  if (k === 'memory' && String(name).trim().startsWith('self')) invalidateSectionIndex();
  // 保存记忆后异步重建全局记忆索引（技能保存不触发，避免误扫描）
  if (kind === 'memory') scheduleRebuildIndex();
  return file + dedupHint;
}

function erase(kind, name) {
  assertWritable(kind);
  if (kind === 'skill') { invalidateSearchCache('skill'); return skills.erase(name); }
  const file = fileOf(kind, name);
  if (fs.existsSync(file)) { fs.unlinkSync(file); removeCacheEntry('memory', name); if (String(name).trim().startsWith('self')) invalidateSectionIndex(); scheduleRebuildIndex(); return true; }
  return false;
}

/**
 * 全文检索（相关度排序，模糊匹配）。
 * 关键词不再要求全部命中：按「命中的查询词比例 + 标题命中加成」打分排序，返回 top-limit。
 * 未命中任何词则不返回。返回 [{name, snippet, score}]。
 */
// ———— 检索内存缓存 + bigram 倒排（v3.1） ————
//  §4.1 倒排：gram -> Set(docId)，docId = slug(name)
//  §4.2 C 打分：idf 加权命中比 + 名命中 + 别名命中；tie-break 用命中密度/稳定序
//  §4.3 保存/启动优化：save/erase 增量；findSimilarMemory 复用缓存；rebuildIndex 免 statSync + 异步；启动后台预热
//  §9.x  H1 stripMeta 四落点 / H3 findSimilarMemory 统一 slug / M3 单一 mtime 源 / L3 data/_synonyms.md / L5 improveSkill 置脏
const SEARCH_CACHE = {
  memory: { map: new Map(), dirty: true, lastCheck: 0, stamp: 0 },
  skill: { map: new Map(), dirty: true, lastCheck: 0, stamp: 0 },
  doc: { map: new Map(), dirty: true, lastCheck: 0, stamp: 0 },      // P1：只读集合（workspace/**/*.md）
  script: { map: new Map(), dirty: true, lastCheck: 0, stamp: 0 },   // P1：只读集合（scripts/*.py + workspace/tools/*）
};
const CACHE_TTL_MS = 30000;
const INDEX = {
  memory: { gram: new Map(), docGrams: new Map(), built: false, stamp: -1 },
  skill: { gram: new Map(), docGrams: new Map(), built: false, stamp: -1 },
  doc: { gram: new Map(), docGrams: new Map(), built: false, stamp: -1 },
  script: { gram: new Map(), docGrams: new Map(), built: false, stamp: -1 },
};
// P1 只读集合定义：kind → 文件枚举器（返回 [{name(相对ROOT路径), path(绝对), abs}]）
const COLLECTIONS = {
  doc: {
    // workspace/**/*.md（递归），排除 projects/ 账本、_archive*、_tmp 临时件、node_modules/.git
    list() {
      const root = path.join(ROOT, 'workspace');
      // 排除：projects 账本、_archive、_tmp、node_modules/.git，以及自动生成的「记忆索引.md」
      //（后者是记忆标题汇总，与任何主题都相关，会频繁抢 doc top1、挤掉真正的方案/规范文档）
      const ex = [/[\\/]projects[\\/]/, /_archive/, /[\\/]_bak/, /[\\/]_tmp[\\/]/, /[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/, /[\\/]记忆索引\.md$/];
      return walkFiles([root], { recursive: true, exts: ['.md'], exclude: ex });
    },
  },
  script: {
    // scripts/*.py（含子目录）+ workspace/tools/*（仅代码/文本扩展名，排除 __pycache__/models/node_modules）
    list() {
      const CODE_EXT = ['.py', '.js', '.mjs', '.ts', '.ps1', '.sh', '.bat', '.md', '.txt'];
      const ex = [/[\\/]node_modules[\\/]/, /[\\/]__pycache__[\\/]/, /[\\/]models[\\/]/, /[\\/]\.git[\\/]/];
      const s1 = walkFiles([path.join(ROOT, 'scripts')], { recursive: true, exts: ['.py'], exclude: ex });
      const s2 = walkFiles([path.join(ROOT, 'workspace', 'tools')], { recursive: true, exts: CODE_EXT, exclude: ex });
      return [...s1, ...s2];
    },
  },
};
/** 通用文件遍历：返回 [{name, path, mtime}]（name=相对 ROOT 的路径，用 / 归一，保证唯一且可读） */
function walkFiles(roots, { recursive = true, exts = null, exclude = [] } = {}) {
  const out = [];
  const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/');
  const excluded = (full) => exclude.some((re) => re.test(full));
  const okExt = (n) => !exts || exts.some((x) => n.toLowerCase().endsWith(x));
  const visit = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (excluded(full)) continue;
      if (e.isDirectory()) { if (recursive) visit(full); }
      else if (e.isFile() && okExt(e.name)) {
        let st; try { st = fs.statSync(full); } catch { continue; }
        out.push({ name: rel(full), path: full, mtime: st.mtimeMs });
      }
    }
  };
  for (const r of roots) {
    let st; try { st = fs.statSync(r); } catch { continue; }
    if (st.isDirectory()) visit(r);
    else if (st.isFile() && okExt(r)) out.push({ name: rel(r), path: r, mtime: st.mtimeMs });
  }
  return out;
}
/** 集合 kind 归一化（未知 → memory，保持旧行为） */
function normalizeKind(kind) {
  return (kind === 'skill' || kind === 'doc' || kind === 'script') ? kind : 'memory';
}
// 停用/高频片：纯数字片与极常见虚词片（IDF 仍会额外降权，此处仅剔除无区分度的）
const STOP_GRAMS = new Set(['的的', '了了', '是是', '000', '111', '222', '333']);

function invalidateSearchCache(kind) {
  const k = kind === 'skill' ? 'skill' : 'memory';
  const c = SEARCH_CACHE[k];
  if (c) { c.dirty = true; c.stamp++; }
  const ix = INDEX[k];
  if (ix) ix.built = false;
}

/** 解析单条原文 → 缓存条目（含 stripMeta 结果与检索用 gram 集）。统一在此处解析，保证展示/检索一致。 */
function makeEntry(name, raw, mtime, extra = {}) {
  const m = stripMeta(raw);
  const aliases = aliasList(m.alias);
  // 检索域 = clean 正文 ∪ 名字 ∪ 别名（别名只进检索域）；skill 的 main.py 文本并入 raw 但它不进别名域
  const searchText = `${m.clean}\n${name}\n${aliases.join(' ')}`;
  const gramSet = new Set(gramsOf(searchText).filter((g) => !STOP_GRAMS.has(g)));
  const nameGrams = new Set(gramsOf(name));
  const aliasGrams = new Set(gramsOf(aliases.join(' ')));
  return { raw, mtime, project: m.project, alias: m.alias, aliases, clean: m.clean, display: m.display, gramSet, nameGrams, aliasGrams, path: extra.path || null };
}

function rebuildMemoryCache() {
  const c = SEARCH_CACHE.memory;
  const map = new Map();
  let files = [];
  try {
    const _exArch = (() => { try { return load().memIndexExcludeArchive !== false; } catch { return true; } })();
    // F1 残留修复：分代归档合并文件（压缩摘要-*-archive.md 等）**不进检索索引**，防其海量 gram 抬高 df、污染 IDF。
    // 注意：read(kind,name) 走 fileOf 按名直读，不受本过滤影响（archive 文件仍可读）；list(kind='memory') 仍展示。
    files = fs.readdirSync(MEM_DIR).filter((x) => x.endsWith('.md') && !(_exArch && x.endsWith('-archive.md')));
  } catch { files = []; }
  for (const f of files) {
    const full = path.join(MEM_DIR, f);
    try {
      const st = fs.statSync(full);
      map.set(f.replace(/\.md$/, ''), makeEntry(f.replace(/\.md$/, ''), fs.readFileSync(full, 'utf8'), st.mtimeMs));
    } catch { /* 单文件失败跳过 */ }
  }
  c.map = map; c.dirty = false; c.lastCheck = Date.now(); c.stamp++;
  INDEX.memory.built = false;
  return map;
}

function rebuildSkillCache() {
  const c = SEARCH_CACHE.skill;
  const map = new Map();
  let entries = [];
  try { entries = fs.readdirSync(SKILL_DIR, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const full = path.join(SKILL_DIR, entry.name);
      try { const st = fs.statSync(full); const nm = entry.name.replace(/\.md$/, ''); map.set(nm, makeEntry(nm, fs.readFileSync(full, 'utf8'), st.mtimeMs)); } catch { }
    } else if (entry.isDirectory()) {
      const md = path.join(SKILL_DIR, entry.name, 'SKILL.md');
      const mp = path.join(SKILL_DIR, entry.name, 'main.py');
      let text = '', mtime = 0, any = false;
      try { if (fs.existsSync(md)) { text += fs.readFileSync(md, 'utf8'); mtime = Math.max(mtime, fs.statSync(md).mtimeMs); any = true; } } catch { }
      try { if (fs.existsSync(mp)) { text += '\n' + fs.readFileSync(mp, 'utf8'); mtime = Math.max(mtime, fs.statSync(mp).mtimeMs); any = true; } } catch { }
      if (any) map.set(entry.name, makeEntry(entry.name, text, mtime));
    }
  }
  c.map = map; c.dirty = false; c.lastCheck = Date.now(); c.stamp++;
  INDEX.skill.built = false;
  return map;
}

/** TTL 到期：stat 全目录比对 mtime，仅重读变更/新增项，删已消失项（M3：mtime 唯一来源=MEM_DIR/SKILL_DIR）。 */
function revalidateMemoryCache() {
  const c = SEARCH_CACHE.memory;
  let files = [];
  try {
    const _exArch = (() => { try { return load().memIndexExcludeArchive !== false; } catch { return true; } })();
    // F1 残留修复：分代归档合并文件（压缩摘要-*-archive.md 等）**不进检索索引**，防其海量 gram 抬高 df、污染 IDF。
    // 注意：read(kind,name) 走 fileOf 按名直读，不受本过滤影响（archive 文件仍可读）；list(kind='memory') 仍展示。
    files = fs.readdirSync(MEM_DIR).filter((x) => x.endsWith('.md') && !(_exArch && x.endsWith('-archive.md')));
  } catch { files = []; }
  const seen = new Set();
  let changed = false;
  for (const f of files) {
    const name = f.replace(/\.md$/, ''); seen.add(name);
    const full = path.join(MEM_DIR, f);
    let st; try { st = fs.statSync(full); } catch { continue; }
    const cur = c.map.get(name);
    if (!cur || cur.mtime !== st.mtimeMs) {
      try { c.map.set(name, makeEntry(name, fs.readFileSync(full, 'utf8'), st.mtimeMs)); changed = true; } catch { }
    }
  }
  for (const name of [...c.map.keys()]) if (!seen.has(name)) { c.map.delete(name); changed = true; }
  c.lastCheck = Date.now();
  if (changed) { c.stamp++; INDEX.memory.built = false; }
}

function revalidateSkillCache() {
  const c = SEARCH_CACHE.skill;
  let entries = [];
  try { entries = fs.readdirSync(SKILL_DIR, { withFileTypes: true }); } catch { entries = []; }
  const seen = new Set();
  let changed = false;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const name = entry.name.replace(/\.md$/, ''); seen.add(name);
      const full = path.join(SKILL_DIR, entry.name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      const cur = c.map.get(name);
      if (!cur || cur.mtime !== st.mtimeMs) { try { c.map.set(name, makeEntry(name, fs.readFileSync(full, 'utf8'), st.mtimeMs)); changed = true; } catch { } }
    } else if (entry.isDirectory()) {
      const name = entry.name; seen.add(name);
      const md = path.join(SKILL_DIR, name, 'SKILL.md');
      const mp = path.join(SKILL_DIR, name, 'main.py');
      let mtime = 0, any = false;
      try { if (fs.existsSync(md)) { mtime = Math.max(mtime, fs.statSync(md).mtimeMs); any = true; } } catch { }
      try { if (fs.existsSync(mp)) { mtime = Math.max(mtime, fs.statSync(mp).mtimeMs); any = true; } } catch { }
      if (!any) continue;
      const cur = c.map.get(name);
      if (!cur || cur.mtime !== mtime) {
        let text = '';
        try { if (fs.existsSync(md)) text += fs.readFileSync(md, 'utf8'); } catch { }
        try { if (fs.existsSync(mp)) text += '\n' + fs.readFileSync(mp, 'utf8'); } catch { }
        c.map.set(name, makeEntry(name, text, mtime)); changed = true;
      }
    }
  }
  for (const name of [...c.map.keys()]) if (!seen.has(name)) { c.map.delete(name); changed = true; }
  c.lastCheck = Date.now();
  if (changed) { c.stamp++; INDEX.skill.built = false; }
}

/** P1：只读集合（doc/script）重建缓存（读盘一次；docId = 相对路径，正文=文件文本） */
function rebuildFileCache(kind) {
  const c = SEARCH_CACHE[kind];
  const map = new Map();
  let files = [];
  try { files = COLLECTIONS[kind].list(); } catch { files = []; }
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f.path, 'utf8');
      map.set(f.name, makeEntry(f.name, raw, f.mtime, { path: f.path }));
    } catch { /* 单文件失败跳过 */ }
  }
  c.map = map; c.dirty = false; c.lastCheck = Date.now(); c.stamp++;
  INDEX[kind].built = false;
  return map;
}
/** P1：只读集合 TTL 校验（重新枚举 + mtime 比对，仅重读变更，删已消失） */
function revalidateFileCache(kind) {
  const c = SEARCH_CACHE[kind];
  let files = [];
  try { files = COLLECTIONS[kind].list(); } catch { files = []; }
  const seen = new Set();
  let changed = false;
  for (const f of files) {
    seen.add(f.name);
    const cur = c.map.get(f.name);
    if (!cur || cur.mtime !== f.mtime) {
      try { c.map.set(f.name, makeEntry(f.name, fs.readFileSync(f.path, 'utf8'), f.mtime, { path: f.path })); changed = true; } catch { }
    }
  }
  for (const name of [...c.map.keys()]) if (!seen.has(name)) { c.map.delete(name); changed = true; }
  c.lastCheck = Date.now();
  if (changed) { c.stamp++; INDEX[kind].built = false; }
}

function getSearchData(kind) {
  const k = normalizeKind(kind);
  const c = SEARCH_CACHE[k];
  const build = { memory: rebuildMemoryCache, skill: rebuildSkillCache, doc: () => rebuildFileCache('doc'), script: () => rebuildFileCache('script') }[k];
  if (c.dirty) return build();
  if (Date.now() - c.lastCheck > CACHE_TTL_MS) {
    const reval = { memory: revalidateMemoryCache, skill: revalidateSkillCache, doc: () => revalidateFileCache('doc'), script: () => revalidateFileCache('script') }[k];
    reval();
  }
  return c.map;
}

// ———— 增量更新（§4.3 清单 11/12） ————
/** 单doc 从倒排中摘除 */
function indexRemoveDoc(kind, docId) {
  const ix = INDEX[kind];
  const gs = ix.docGrams.get(docId);
  if (!gs) return;
  for (const g of gs) { const set = ix.gram.get(g); if (set) { set.delete(docId); if (!set.size) ix.gram.delete(g); } }
  ix.docGrams.delete(docId);
}
/** 单doc 写入倒排 */
function indexAddDoc(kind, docId, entry) {
  const ix = INDEX[kind];
  ix.docGrams.set(docId, entry.gramSet);
  for (const g of entry.gramSet) { let set = ix.gram.get(g); if (!set) { set = new Set(); ix.gram.set(g, set); } set.add(docId); }
}
/** save 后：缓存与倒排增量更新（不整库重建） */
function updateCacheEntry(kind, name) {
  const k = kind === 'skill' ? 'skill' : 'memory';
  const c = SEARCH_CACHE[k];
  if (c.dirty) return;   // 已经是"下次重建"状态，增量无意义
  const docId = slug(name);
  try {
    if (k === 'memory') {
      const file = path.join(MEM_DIR, docId + '.md');
      if (!fs.existsSync(file)) return;
      const st = fs.statSync(file);
      const entry = makeEntry(docId, fs.readFileSync(file, 'utf8'), st.mtimeMs);
      c.map.set(docId, entry);
      if (INDEX[k].built) { indexRemoveDoc(k, docId); indexAddDoc(k, docId, entry); }
      c.stamp++;
    }
  } catch { invalidateSearchCache(k); }
}
function removeCacheEntry(kind, name) {
  const k = kind === 'skill' ? 'skill' : 'memory';
  const c = SEARCH_CACHE[k];
  const docId = slug(name);
  try { c.map.delete(docId); } catch { }
  if (INDEX[k].built) indexRemoveDoc(k, docId);
  c.stamp++;
}

// ———— 语义索引 L0：data/_synonyms.md（§三/L3） ————
const SYNONYMS_PATH = path.join(DATA_DIR, '_synonyms.md');
let _synCache = { mtime: -1, map: new Map() };
function loadSynonyms() {
  try {
    let st = 0;
    try { st = fs.statSync(SYNONYMS_PATH).mtimeMs; } catch { st = 0; }
    if (st === _synCache.mtime) return _synCache.map;
    const map = new Map();
    if (st) {
      const raw = fs.readFileSync(SYNONYMS_PATH, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('>')) continue;
        const parts = t.split(/[=，,、;；]+/).map((x) => x.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        for (const p of parts) {
          const key = p.toLowerCase();
          if (!map.has(key)) map.set(key, new Set());
          for (const q of parts) map.get(key).add(q);
        }
      }
    }
    _synCache = { mtime: st, map };
    return map;
  } catch { return new Map(); }
}
/** 查询期同义词扩展：返回额外检索串数组（不含原词）。 */
function synonymExpand(query) {
  const map = loadSynonyms();
  if (!map.size) return [];
  const toks = String(query || '').toLowerCase().split(/[\s,，。、;；:：=+\/\\|()（）\[\]【】"']+/).filter(Boolean);
  const extra = new Set();
  for (const tk of toks) {
    const hit = map.get(tk);
    if (hit) for (const v of hit) if (v.toLowerCase() !== tk) extra.add(v);
    // 长 token 内切词再查（如"缓存命中"→"缓存"）
    for (const key of map.keys()) if (key.length >= 2 && tk.includes(key)) for (const v of map.get(key)) extra.add(v);
  }
  return [...extra];
}

// ———— 倒排构建（懒构建；后台预热） ————
function ensureIndex(kind) {
  const k = normalizeKind(kind);
  const ix = INDEX[k];
  const c = SEARCH_CACHE[k];
  if (ix.built && ix.stamp === c.stamp) return ix;
  const data = getSearchData(k);
  ix.gram = new Map(); ix.docGrams = new Map();
  for (const [name, entry] of data) {
    const docId = name;   // docId = 缓存文件表原始键（= slug 后的文件名；保证与 data.get 一致、返回名不被改写）
    ix.docGrams.set(docId, entry.gramSet);
    for (const g of entry.gramSet) { let set = ix.gram.get(g); if (!set) { set = new Set(); ix.gram.set(g, set); } set.add(docId); }
  }
  ix.built = true; ix.stamp = c.stamp;
  return ix;
}

// ———— 埋点（§五清单 16）：0 命中 / 低置信 → miss_log ————
const MISS_LOG = path.join(DATA_DIR, 'memory_miss_log.jsonl');
function logMiss(query, kind, top, reason) {
  try {
    fs.appendFileSync(MISS_LOG, JSON.stringify({ ts: new Date().toISOString(), query: String(query).slice(0, 200), kind, top, reason }) + '\n', 'utf8');
  } catch { }
}

// ———— 启动后台预热（清单 15）：不阻塞，错峰建索引 ————
let _warmed = false;
function warmUp() {
  if (_warmed) return; _warmed = true;
  try {
    setImmediate(() => {
      try { ensureIndex('memory'); ensureIndex('skill'); } catch { }
      try { ensureSectionIndex('self'); } catch { }   // V3：一并预热自我认知段级索引
    });
    if (typeof setTimeout === 'function') { /* 预留：idle 优先级 */ }
  } catch { }
}

// ———— 单字/符号 query fallback（清单 4） ————
function fallbackSubstring(kind, query, limit) {
  const kk = normalizeKind(kind);
  const toks = String(query || '').split(/[\s,，。、;；]+/).filter(Boolean);
  if (!toks.length) return [];
  const data = getSearchData(kk);
  const results = [];
  for (const [name, entry] of data) {
    const hay = `${entry.clean}\n${name}\n${entry.aliases.join(' ')}`.toLowerCase();
    let hit = 0, pos = -1;
    for (const w of toks) { const idx = hay.indexOf(w.toLowerCase()); if (idx >= 0) { hit++; if (pos < 0 || idx < pos) pos = idx; } }
    if (!hit) continue;
    const score = Math.round(((hit / toks.length) + (String(name).toLowerCase().includes(String(query).toLowerCase()) ? 0.5 : 0)) * 100) / 100;
    const p0 = pos >= 0 ? pos : 0;
    const snippet = entry.clean.slice(Math.max(0, p0 - 40), p0 + 160).replace(/\s+/g, ' ').trim() || name;
    const rec = { name, snippet, score, project: entry.project || '' };
    if (entry.path) rec.path = entry.path;
    results.push(rec);
  }
  return results.sort((a, b) => (b.score - a.score) || (b.snippet.length - a.snippet.length)).slice(0, limit);
}

/**
 * 全文检索 v3.1：bigram 倒排 + C 打分（idf 加权）+ 显式语义索引（别名/同义词）。
 * 检索域 = stripMeta 后的 clean 正文 ∪ 名字 ∪ 别名（别名只进检索域，绝不进展示）∪ 查询期同义词扩展。
 * 返回 [{name, snippet, score, project}]，top-limit（内核默认 limit=6，snippet 200 字）。
 * ⚠ 语义变更（已获主我认可）：整词匹配 → bigram 匹配，结果集与旧版不同，实测"真实 query 0 命中率 3%→0%"。
 */
function search(query, { kind = 'memory', limit = 6 } = {}) {
  ensure();
  const k = normalizeKind(kind);
  const q = String(query == null ? '' : query);
  const data = getSearchData(k);
  if (!data.size) return [];

  const qNorm = normText(q);                                             // v3.2：归一化查询串（phrase 精确匹配用）
  const qNormName = String(q || '').toLowerCase().trim();                // 名字/别名域（保留原样小写，不做去标点）
  const qGramsRaw = [...new Set(gramsOf(q).filter((g) => !STOP_GRAMS.has(g)))];
  const synWords = synonymExpand(q);
  const synGramsRaw = [...new Set(gramsOf(synWords.join(' ')).filter((g) => !STOP_GRAMS.has(g)))];

  // 清单 4：单字/符号 query（无可用 bigram）→ 回退旧式子串匹配（不崩、有 fallback）
  if (!qGramsRaw.length) {
    const fb = fallbackSubstring(k, q, limit);
    if (!fb.length) logMiss(q, k, 0, 'no-gram-fallback-miss');
    return fb;
  }

  const ix = ensureIndex(k);
  const N = data.size || 1;

  // idf：越高频的片越低权（§4.1 高频片 IDF 降权 + 停用表）
  // v3.2 数字命中加权：≥3 位数字 token 权重 ×NUM_W（端口/ID 查询不再被泛片带偏）
  const NUM_W = 2.5;
  const idf = (g) => {
    const set = ix.gram.get(g); const df = set ? set.size : 0;
    let w = Math.log(1 + N / (1 + df));
    if (isNumToken(g)) w *= NUM_W;
    return w;
  };
  // 预算 idf（内层不再重复 Map 查询 → 显著提速）
  const qIdf = new Map();
  let qIdfSum = 0;
  for (const g of qGramsRaw) { const w = idf(g); qIdf.set(g, w); qIdfSum += w; }
  if (!qIdfSum) qIdfSum = 1;

  // 候选 = 查询 bigram（∪ 同义词 bigram）命中的 doc 并集（稀有优先，界内直接并集）
  const cand = new Set();
  for (const g of qGramsRaw) { const set = ix.gram.get(g); if (set) for (const d of set) cand.add(d); }
  for (const g of synGramsRaw) { const set = ix.gram.get(g); if (set) for (const d of set) cand.add(d); }

  const W_NAME = 0.4, W_ALIAS = 0.3, W_SYN = 0.5;   // §4.2 重校权重（不再沿用旧 0.5 单名加成）
  const results = [];
  for (const docId of cand) {
    const entry = data.get(docId);
    if (!entry) continue;
    // 主体命中比（idf 加权）
    let matched = 0, hitCount = 0;
    for (const [g, w] of qIdf) { if (entry.gramSet.has(g)) { matched += w; hitCount++; } }
    if (matched <= 0) continue;
    const ratio = matched / qIdfSum;
    // 同义词命中比
    let synRatio = 0;
    if (synGramsRaw.length) {
      let sm = 0, sN = 0;
      for (const g of synGramsRaw) { sN += 1; if (entry.gramSet.has(g)) sm += 1; }
      synRatio = sN ? sm / sN : 0;
    }
    const nameHit = qGramsRaw.some((g) => entry.nameGrams.has(g)) ? W_NAME : 0;
    const aliasHit = (entry.aliasGrams && entry.aliasGrams.size) && qGramsRaw.some((g) => entry.aliasGrams.has(g)) ? W_ALIAS : 0;
    // v3.2 修 P0-精确原串奖励：查询归一化后**连续出现**在记忆正文/名字里 → 显著且**不封顶**的 phrase bonus
    //   （红队 A1：长文档精确子串 ratio 封顶 1.0 后被"短文档仅凭名字"反超；此项消掉全部 9 例长文滑落）
    const phraseBonus = phraseBonusOf(entry, qNorm, qNormName);
    const rawScore = ratio + synRatio * W_SYN + nameHit + aliasHit + phraseBonus;
    // v3.2 修 P1-tie-break：由「命中片数/文档总片数」改为「命中片数」——解除对长文档的系统性惩罚
    const hits = hitCount;
    // —— snippet：基于 clean 定位（别名只进检索域，故锚点只用 clean；M1：无锚点回退名字/首行） ——
    const clean = entry.clean || '';
    const lower = clean.toLowerCase();
    let pos = -1;
    for (const g of qGramsRaw) { const idx = lower.indexOf(g); if (idx >= 0 && (pos < 0 || idx < pos)) pos = idx; }
    if (pos < 0) { const qq = lower.indexOf(q.toLowerCase().trim()); if (qq >= 0) pos = qq; }
    let snippet;
    if (pos >= 0) snippet = clean.slice(Math.max(0, pos - 40), pos + 160).replace(/\s+/g, ' ').trim();
    if (!snippet) snippet = (entry.display || entry.clean || docId).slice(0, 200).replace(/\s+/g, ' ').trim();   // M1 回退锚点
    const rec = { name: docId, snippet, score: Math.round(rawScore * 100) / 100, project: entry.project || '', _hits: hits };
    if (entry.path) rec.path = entry.path;   // P1：doc/script 集合附带绝对路径
    results.push(rec);
  }

  // v3.2 tie-break：score → 命中片数（多者优，不按文档长度归一）→ 名字稳定序
  results.sort((a, b) => (b.score - a.score) || (b._hits - a._hits) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const top = results.slice(0, limit).map(({ _hits, ...r }) => r);   // 内部字段不外泄
  // 清单 16：0 命中 / 低置信 → miss_log（供自愈闭环）
  if (!top.length) logMiss(q, k, 0, 'zero-hit');
  else if (top[0].score < 0.2) logMiss(q, k, top[0].score, 'low-confidence');
  return top;
}

// ———— V3 · 自我认知段级索引（独立于 4 个现有 kind，只服务 self-*.md 的「段」检索） ————
//  §动机：self-*.md 每文件 ~40 段（`## 段名`），文件级检索返回整文件=噪声；段级倒排直出候选段。
//  §检索域 = 段名 + 段正文（标题也进检索域，弥补 stripMeta 剥离 `#` 行）。
//  §评分逻辑与 search() 同款（idf 加权命中比 + 名命中 + phrase bonus）；不触碰 memory/skill/doc/script 行为。
const SELF_SECTION_CACHE = { map: new Map(), dirty: true, lastCheck: 0, stamp: 0, sig: '' };
const SECTION_INDEX = { gram: new Map(), docGrams: new Map(), built: false, stamp: -1 };
const SECTION_TTL_MS = 30000;
const SECTION_HEAD_RE = /^##[^\S\n]+(.+?)\s*$/gm;   // `## 段名`（不误伤 `###`）

function _readSelfSectionFiles(filePrefix) {
  try { return fs.readdirSync(MEM_DIR).filter((x) => x.endsWith('.md') && x.startsWith(filePrefix)); } catch { return []; }
}

/** 段级子文档表：docId=`<文件名>§<段名>` -> entry（含 file/section/body）。懒构建 + stamp/TTL。 */
function getSelfSectionData(filePrefix = 'self') {
  const c = SELF_SECTION_CACHE;
  if (c.dirty) return rebuildSelfSectionCache(filePrefix);
  if (Date.now() - c.lastCheck > SECTION_TTL_MS) return revalidateSelfSectionCache(filePrefix);
  return c.map;
}

function rebuildSelfSectionCache(filePrefix = 'self') {
  const c = SELF_SECTION_CACHE;
  const map = new Map();
  const files = _readSelfSectionFiles(filePrefix);
  let latest = 0;
  for (const f of files) {
    const full = path.join(MEM_DIR, f);
    let raw, mtime = 0;
    try { const st = fs.statSync(full); mtime = st.mtimeMs; raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (mtime > latest) latest = mtime;
    const base = f.replace(/\.md$/, '');
    const t = String(raw || '');
    const parts = []; let m, last = null;
    SECTION_HEAD_RE.lastIndex = 0;
    while ((m = SECTION_HEAD_RE.exec(t))) {
      if (last) parts.push({ title: last.title, body: t.slice(last.end, m.index) });
      last = { title: m[1].trim(), end: SECTION_HEAD_RE.lastIndex };
    }
    if (last) parts.push({ title: last.title, body: t.slice(last.end) });
    const titleSeq = new Map();   // 段名 -> 出现序（同题异文段不覆盖，缺陷 A 修复）
    for (const p of parts) {
      const section = p.title; if (!section) continue;
      const body = p.body.replace(/^#\s+.*$/gm, '').replace(/\s+/g, ' ').trim();   // 剥段内 `#` 行（旧运行时同款）
      if (!body) continue;
      const seq = (titleSeq.get(section) || 0) + 1; titleSeq.set(section, seq);
      const entry = makeEntry(section, `${section}\n${body}`, mtime);   // 检索域含段名（标题）
      entry.file = base; entry.section = section; entry.body = body;
      map.set(`${base}§${section}#${seq}`, entry);
    }
  }
  c.map = map; c.dirty = false; c.lastCheck = Date.now(); c.stamp++;
  c.sig = `${files.length}|${latest}`;
  SECTION_INDEX.built = false;
  return map;
}

function revalidateSelfSectionCache(filePrefix = 'self') {
  const c = SELF_SECTION_CACHE;
  const files = _readSelfSectionFiles(filePrefix);
  let latest = 0;
  for (const f of files) { try { const st = fs.statSync(path.join(MEM_DIR, f)); if (st.mtimeMs > latest) latest = st.mtimeMs; } catch { } }
  if (c.sig !== `${files.length}|${latest}`) return rebuildSelfSectionCache(filePrefix);
  c.lastCheck = Date.now();
  return c.map;
}

/** 段级索引主动失效（save 新 self 段后调用）。 */
function invalidateSectionIndex() {
  const c = SELF_SECTION_CACHE;
  c.dirty = true; c.stamp++;
  SECTION_INDEX.built = false;
}

function ensureSectionIndex(filePrefix = 'self') {
  const c = SELF_SECTION_CACHE;
  if (SECTION_INDEX.built && SECTION_INDEX.stamp === c.stamp) return SECTION_INDEX;
  const data = getSelfSectionData(filePrefix);
  const ix = SECTION_INDEX;
  ix.gram = new Map(); ix.docGrams = new Map();
  for (const [docId, entry] of data) {
    ix.docGrams.set(docId, entry.gramSet);
    for (const g of entry.gramSet) { let set = ix.gram.get(g); if (!set) { set = new Set(); ix.gram.set(g, set); } set.add(docId); }
  }
  ix.built = true; ix.stamp = c.stamp;
  return ix;
}

/** 段级检索：返回 [{file, section, snippet(≤200), score}]（按 score→命中片数→文件名稳定序）。 */
function searchSelfSections(query, { limit = 3, filePrefix = 'self' } = {}) {
  ensure();
  const q = String(query == null ? '' : query);
  const data = getSelfSectionData(filePrefix);
  if (!data.size) return [];
  const qNorm = normText(q);
  const qNormName = String(q || '').toLowerCase().trim();
  const qGramsRaw = [...new Set(gramsOf(q).filter((g) => !STOP_GRAMS.has(g)))];
  if (!qGramsRaw.length) return [];      // 单字/符号：段级无 bigram → 空（不注入噪声）
  const ix = ensureSectionIndex(filePrefix);
  const N = data.size || 1;
  const NUM_W = 2.5;
  const idf = (g) => { const set = ix.gram.get(g); const df = set ? set.size : 0; let w = Math.log(1 + N / (1 + df)); if (isNumToken(g)) w *= NUM_W; return w; };
  const qIdf = new Map(); let qIdfSum = 0;
  for (const g of qGramsRaw) { const w = idf(g); qIdf.set(g, w); qIdfSum += w; }
  if (!qIdfSum) qIdfSum = 1;
  const cand = new Set();
  for (const g of qGramsRaw) { const set = ix.gram.get(g); if (set) for (const d of set) cand.add(d); }
  const W_NAME = 0.4;
  const results = [];
  for (const docId of cand) {
    const entry = data.get(docId);
    if (!entry) continue;
    let matched = 0, hitCount = 0;
    for (const [g, w] of qIdf) { if (entry.gramSet.has(g)) { matched += w; hitCount++; } }
    if (matched <= 0) continue;
    const ratio = matched / qIdfSum;
    const nameHit = qGramsRaw.some((g) => entry.nameGrams.has(g)) ? W_NAME : 0;
    const phraseBonus = phraseBonusOf(entry, qNorm, qNormName);
    const rawScore = ratio + nameHit + phraseBonus;
    const text = entry.body || entry.clean || '';
    const lower = text.toLowerCase();
    let pos = -1;
    for (const g of qGramsRaw) { const idx = lower.indexOf(g); if (idx >= 0 && (pos < 0 || idx < pos)) pos = idx; }
    let snippet;
    if (pos >= 0) snippet = text.slice(pos, pos + 180).replace(/\s+/g, ' ').trim();
    if (!snippet) snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    results.push({ file: entry.file, section: entry.section, snippet: snippet.slice(0, 200), score: Math.round(rawScore * 100) / 100, _hits: hitCount });
  }
  results.sort((a, b) => (b.score - a.score) || (b._hits - a._hits) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return results.slice(0, limit).map(({ _hits, ...r }) => r);
}

// ———— V3 · 自我认知主题归类（缺陷 B 修复：reflect 不再新建碎片文件，归入 21 主题文件） ————
//  单一来源：主题名 → 关键词表（顺序即优先级，先命中先归）；无匹配 → 默认主题。
const SELF_TOPIC_MAP = [
  ['界面与视觉', ['界面', '视觉', '前端', 'ui', '下拉', '样式', '布局', '渲染', '截图', 'cdp', 'webui', '展示', '图标', '颜色', '字体', '悬停', '弹窗', '列表']],
  ['查证与实测优先', ['查证', '实测', '先查', '证据分级', '阴性', '交叉验证', '量化']],
  ['验证与取证', ['验证', '验收', '复验', '抽验', '度量', '证据']],
  ['前缀与护栏', ['前缀', '护栏', '击穿', '进化', 'prompt']],
  ['成本与缓存', ['成本', '计费', 'token', '预算', '用量', '费用', '缓存', '价格']],
  ['引擎与进程运维', ['引擎', '进程', '端口', '重启', '服务', 'node', 'pid', '启动', '监听', '源码']],
  ['派单与雷影协作', ['派单', '雷影', '子智能体', '任务书', '回执', '委派', 'agent', '信箱', '邮箱', '协作']],
  ['收口与交付', ['收口', '交付', '勾销', '待办', '成果', '落地']],
  ['沟通与汇报', ['沟通', '汇报', '措辞', '可读性', '报告', '语气', '回复']],
  ['自主与决策', ['自主', '决策', '拍板', '方向', '确认']],
  ['自我沉淀与职责', ['沉淀', '职责', '边界', '记忆规则']],
  ['自我认知与反思', ['自我认知', '反思', '元认知', '自省', '自我模型', '自指']],
  ['落点与临时资源', ['落点', '临时', '产物', '总库', '项目文件', '备份']],
  ['规则与纪律', ['规则', '纪律', '红线', '规范', '约束', 'harness']],
  ['记忆与上下文', ['记忆', '上下文', '召回', '归档', '压缩', '交接文档', '索引', '主题合并', '合并主题']],
  ['错误处理与根因', ['错误', '根因', '失败', '异常', '排查', '修复', 'bug', '缺陷', '报错', '回滚']],
  ['项目与任务', ['项目', '任务', '进度', '会话', '计划']],
  ['命令与文件经验', ['命令', '文件', '编码', 'bom', 'powershell', 'python', 'grep', '读写', '删除', '路径']],
  ['心跳与巡检', ['心跳', '巡检', '定时', '周期', '轮询', '调度']],
  ['技能与工具', ['技能', '工具', '插件', 'skill', '函数', '封装', 'api']],
];
const SELF_DEFAULT_TOPIC = '其他2';

/** 名称 → 主题名（顺序命中，无匹配 → 其他2）。以**名称**为准（正文词太多易误判）。 */
function selfTopicOf(name) {
  const hay = String(name || '').toLowerCase();
  for (const [topic, kws] of SELF_TOPIC_MAP) { if (kws.some((k) => hay.includes(k))) return topic; }
  return SELF_DEFAULT_TOPIC;
}

/** 把一条自我认知**归入对应主题文件**（`self-<主题>.md`）以 `## <名>` 段原位写入（不新建碎片文件）。
 *  **幂等**：同文件内已存在同名 `## <名>` 段 → 内容相同则跳过、内容不同则**原位替换**（保最新），绝不新增重复段。
 *  reflect 写自我认知的唯一入口；写后段级索引失效。
 *  @returns {string} 目标文件绝对路径 */
function _parseSelfSections(text) {
  const re = /^##[^\S\n]+(.+?)\s*$/gm;
  const marks = []; let m; re.lastIndex = 0;
  while ((m = re.exec(text))) marks.push({ title: m[1].trim(), index: m.index, bodyStart: re.lastIndex });
  if (!marks.length) return { head: text, blocks: [] };
  const head = text.slice(0, marks[0].index);
  const blocks = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    blocks.push({ title: marks[i].title, body: text.slice(marks[i].bodyStart, end) });
  }
  return { head, blocks };
}
function _renderSelfSections(head, blocks) {
  let out = head.replace(/\s*$/, '') + (head.trim() ? '\n' : '');
  for (const b of blocks) out += `\n## ${b.title}\n${String(b.body).replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
  return out.replace(/\n{3,}/g, '\n\n');
}
function _normBody(x) { return String(x || '').replace(/\s+/g, ' ').trim(); }

function appendSelfSection(name, content) {
  ensure();
  const cleanName = String(name == null ? '' : name).replace(/^(?:self[:：]?\s*)+/i, '').replace(/[\r\n]+/g, ' ').trim() || '未命名认知';
  const body = String(content == null ? '' : content).replace(/\r\n/g, '\n').replace(/^#{1,6}\s+/gm, '').trim();   // 去内嵌标题，防段被切碎
  const topic = selfTopicOf(cleanName);
  const file = path.join(MEM_DIR, `self-${topic}.md`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# self:${topic}（主题合并 · ${new Date().toISOString().slice(0, 10)}）\n\n## ${cleanName}\n${body}\n`, 'utf8');
    invalidateSectionIndex();
    return file;
  }
  const text = fs.readFileSync(file, 'utf8');
  const { head, blocks } = _parseSelfSections(text);
  const idxs = [];
  for (let i = 0; i < blocks.length; i++) if (blocks[i].title === cleanName) idxs.push(i);
  if (idxs.length === 1 && _normBody(blocks[idxs[0]].body) === _normBody(body)) {
    return file;   // 幂等：完全相同 → 跳过（不写盘、不失效）
  }
  const at = idxs.length ? idxs[0] : blocks.length;   // 原位替换首个匹配；否则追加到末尾
  for (let i = idxs.length - 1; i >= 0; i--) blocks.splice(idxs[i], 1);   // 清除同题旧段（含历史重复）
  const insertAt = Math.min(at, blocks.length);
  blocks.splice(insertAt, 0, { title: cleanName, body });
  fs.writeFileSync(file, _renderSelfSections(head, blocks), 'utf8');
  invalidateSectionIndex();
  return file;
}

module.exports = { list, read, save, erase, search, searchSelfSections, appendSelfSection, selfTopicOf, invalidateSectionIndex, getSelfSectionData, fileOf, skillFile, gramsOf, normText, logMiss, MEM_DIR, SKILL_DIR, invalidateSearchCache, stripMeta, extractAlias, aliasList, loadSynonyms, synonymExpand, rebuildIndex, warmUp, ensureIndex, SEARCH_CACHE, INDEX, COLLECTIONS, normalizeKind, archiveSave, archiveSearch, archiveRead, archiveCount, archiveErase, archiveClear, ARCHIVE_DIR, improveSkill: (name, note, opts) => { invalidateSearchCache('skill'); const r = skills.improve(name, note, opts); invalidateSearchCache('skill'); return r; } };

// 清单 15：启动后台预热（不阻塞主流程）
try { warmUp(); } catch { }

/** TODO(清单 20/§L1)：data/memory/_archive*.md 为归档区，**有意不参与热检索**（避免归档稀释结果）。
 *  后续若需检索归档，可给 recall_memory 增 `includeArchive:true` 通道（本期不实现，仅留通道位）。 */
