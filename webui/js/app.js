// A1 前端 · 入口（T-C1/C6/C7）——分区挂载（顶层 #app 不替换）+ 全局接线
// 美工 index.html 提供静态骨架与挂载点；本文件把各动态区挂上 Vue 组件，并绑定全局交互。
import { createApp, markRaw } from 'vue';
import { api } from './api.js';
import { store, toast, clearInbound, setReducedMotion, ensureMessages, setTurnHistory, normalizeTurnUsage } from './store.js';
import { startGlobalEvents, normalizeMsg, onServerEvent, chat } from './sse.js';
import { initLlmStatus } from './llm-status.js';
import { bridge } from './bridge.js';
import { initMediaInteract } from './media-interact.js';

import { SessionList } from './views/sessions.js';
import { VitalsBar, ModelBadge } from './views/topbar.js';
import { OrbitView, GenRings, NexusCards } from './views/nexus.js';
import { MessageStream, SessionAgents, initComposer } from './views/core.js';
import { initAskBox } from './views/askbox.js';
import { initScopeSelect } from './views/scope-select.js';
import { TaskSpine } from './components/task-spine.js';
import { AgentWall, MailTimeline, DispatchPanel } from './views/dock.js';
import { CommCenter } from './views/commcenter.js';
import { PaneProfile, PaneEvolution, PaneMemory, PaneSkills, PaneGrowth, PaneArchive, PaneTree, PaneTreeView } from './views/mirror.js';
import { GoalsList, SchedulesList, SubagentsList } from './views/forge.js';
import { SettingsNav, SettingsForm } from './views/console.js';
import { LiveFeed, VitalsMini } from './views/feed.js';
import { ToastHost, ModalHost, TooltipHost } from './views/overlays.js';
import { PaletteList } from './views/palette.js';

// —— 挂载注册表（选择器 → 组件）——
const MOUNTS = [
  ['#session-list', SessionList],
  ['#vitals', VitalsBar],
  ['#vital-model', ModelBadge],
  ['#thread-tabs', SessionAgents],
  ['#msg-stream', MessageStream],
  ['#task-spine', TaskSpine],
  ['#orbit', OrbitView],
  ['#gen-rings', GenRings],
  ['#nexus-cards', NexusCards],
  ['#agent-wall', AgentWall],
  ['#mail-timeline', MailTimeline],
  ['#dispatch-panel', DispatchPanel],
  ['#comm-center', CommCenter],
  ['#pane-profile', PaneProfile],
  ['#pane-evolution', PaneEvolution],
  ['#pane-memory', PaneMemory],
  ['#pane-skills', PaneSkills],
  ['#pane-growth', PaneGrowth],
  ['#pane-archive', PaneArchive],
  ['#pane-tree', PaneTree],
  ['#goals-list', GoalsList],
  ['#schedules-list', SchedulesList],
  ['#subagents-list', SubagentsList],
  ['#settings-nav', SettingsNav],
  ['#settings-form', SettingsForm],
  ['#live-feed', LiveFeed],
  ['#vitals-mini', VitalsMini],
  ['#palette-list', PaletteList],
  ['#toast-host', ToastHost],
  ['#modal-host', ModalHost],
  ['#tooltip', TooltipHost],
];

function mountAll() {
  for (const [sel, comp] of MOUNTS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    try {
      createApp(comp).mount(el);
      // 去重 id：Vue 保留 host 元素（含 id），若组件根 id 与之同名则移除根上的 id
      const root = el.firstElementChild;
      if (root && root !== el && root.id && root.id === el.id) root.removeAttribute('id');
    } catch (e) { console.error('[mount]', sel, e); }
  }
}

// —— 舱切换 ——
const BERTHS = ['nexus', 'core', 'dock', 'mirror', 'forge', 'console'];
function setBerth(b) {
  if (!BERTHS.includes(b)) b = 'nexus';
  store.view = b;
  document.querySelectorAll('.berth').forEach((s) => s.classList.toggle('is-active', s.dataset.berth === b));
  document.querySelectorAll('.rail-btn[data-berth]').forEach((x) => x.classList.toggle('is-active', x.dataset.berth === b));
  const sm = document.getElementById('status-mode');
  if (sm) sm.textContent = (store.mode === 'classic' ? '经典' : '全景') + ' · ' + b;
}

// —— 每舱经典子切换（P-7，.berth-classic-toggle）——
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { } }

function applyClassic(berth, on) {
  store.classic[berth] = !!on;
  lsSet('leizai.classic.' + berth, on ? '1' : '0');
  const btn = document.querySelector('.berth-classic-toggle[data-berth="' + berth + '"]');
  if (btn) btn.classList.toggle('is-active', !!on);
  const sec = document.querySelector('section.berth[data-berth="' + berth + '"]');
  if (sec) sec.classList.toggle('is-classic', !!on);
  // 经典态的空间化/列表形态切换由美工 CSS 承接（.berth.is-classic .nexus-canvas{display:none}
  // / .nexus-cards{display:grid} / .card-grid 单列 / .orbit-node 静止）——JS 只切 class，不写 inline display。
}
function initClassicToggles() {
  document.querySelectorAll('.berth-classic-toggle[data-berth]').forEach((b) => {
    const berth = b.dataset.berth;
    const saved = lsGet('leizai.classic.' + berth);
    if (saved === '1') applyClassic(berth, true);
    b.addEventListener('click', () => applyClassic(berth, !store.classic[berth]));
  });
}

// —— 会话树入口（雷影·美工）：核心舱头部按钮 → 打开"本会话"泳道图浮层 ——
//   复用 PaneTree（自持数据源 store.currentId + api.sessionTree），复用 ModalHost 的 kind='component' 通道。
function initSessionTreeButton() {
  const btn = document.getElementById('btn-session-tree');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!store.currentId) { toast('尚未选择会话', 'err'); return; }
    store.modal = { title: '会话树 · 本会话', kind: 'component', component: markRaw(PaneTreeView),
      size: 'xwide', wide: true, scroll: false, okText: '关闭' };
  });
}

// —— v6.15 舱内子标签切换（自省舱 6 个子标签此前是裸 HTML、无点击处理 → 除画像外永久隐藏）——
// 通用接线：凡 .subtabs 内含 .subtab[data-pane] 且同舱存在 .mirror-pane[data-pane] → 点击切换 pane 显隐 + is-active。
// 其它舱不含 .mirror-pane，自动跳过，互不干扰。
function initSubtabs() {
  document.querySelectorAll('.subtabs').forEach((nav) => {
    const berth = nav.closest('.berth');
    if (!berth) return;
    const panes = berth.querySelectorAll('.mirror-pane[data-pane]');
    const btns = nav.querySelectorAll('.subtab[data-pane]');
    if (!panes.length || !btns.length) return;
    const activate = (pane) => {
      btns.forEach((b) => b.classList.toggle('is-active', b.dataset.pane === pane));
      panes.forEach((p) => { if (p.dataset.pane === pane) p.removeAttribute('hidden'); else p.setAttribute('hidden', ''); });
      // 世代（archive）/ 树（tree）懒加载：切到该页时按当前会话重载
      if (pane === 'archive' && window.__leizaiReloadArchive) { try { window.__leizaiReloadArchive(); } catch { } }
      if (pane === 'tree' && window.__leizaiReloadTree) { try { window.__leizaiReloadTree(); } catch { } }
    };
    btns.forEach((b) => b.addEventListener('click', () => activate(b.dataset.pane)));
    const curBtn = nav.querySelector('.subtab.is-active[data-pane]') || btns[0];
    activate(curBtn.dataset.pane);   // 尊重 HTML 初始态（默认画像）
  });
}

// —— 雷影协同开关（核心区头右侧）：控制"自动领域分流"总开闭；状态持久化 config.roleDispatchEnabled ——
function setDispatchSwitch(on) {
  const btn = document.getElementById('berth-toggle-dispatch');
  if (!btn) return;
  btn.classList.toggle('is-on', !!on);
  btn.setAttribute('aria-checked', String(!!on));
}
async function initRoleDispatchToggle() {
  const btn = document.getElementById('berth-toggle-dispatch');
  if (!btn) return;
  let cfg = null;
  try { cfg = await api.config(); } catch { cfg = null; }
if (cfg && cfg.contextBudget != null) store.defaultBudget = Number(cfg.contextBudget) || 0;   // v1：顶栏「预算」显示全局默认预算
  setDispatchSwitch(!(cfg && cfg.roleDispatchEnabled === false));   // 默认开启
  btn.addEventListener('click', async () => {
    const next = !btn.classList.contains('is-on');
    setDispatchSwitch(next);   // 乐观更新
    try {
      // ★只提交增量字段（PUT 是 {...cur,...body} 部分合并）——绝不回写整份 config（含掩码 apiKey 会覆盖真 key）
      await api.saveConfig({ roleDispatchEnabled: next });
      toast(next ? '雷影协同已开启' : '雷影协同已关闭', 'ok');
    } catch (e) {
      setDispatchSwitch(!next);   // 失败回滚
      toast('切换失败：' + ((e && e.message) || e), 'err');
    }
  });
}

// —— 全局数据加载 ——
async function loadGlobals() {
  try { store.health = await api.health(); } catch { }
  try { store.daemon = await api.daemon(); } catch { }
  try { store.stats = await api.stats(); } catch { }
  try { store.balance = await api.balance(); } catch { }
  try { store.mailbox = await api.mailboxSummary(); } catch { }
  updateStatus(); updateCorePulse();
}
// v6.9：顶栏未读角标刷新（周期 + SSE 事件双触发，让"已处理"的角标能及时归零）
async function refreshMailbox() { try { const s = await api.mailboxSummary(); store.mailbox = { roles: s.roles || [], totalUnread: s.totalUnread || 0 }; } catch { } }
// v6.12 未送达派单可见化：通讯中心入口（Dock 舱 rail 按钮）角标，仅 >0 显示；端点不可用则隐藏，绝不崩坏
function applyDockBadge(n) {
  const btn = document.querySelector('.rail-btn[data-berth="dock"]');
  if (!btn) return;
  let dot = btn.querySelector('.rail-dot');
  if (typeof n === 'number' && n > 0) {
    if (!dot) { dot = document.createElement('span'); dot.className = 'rail-dot'; btn.appendChild(dot); }
    dot.textContent = n > 99 ? '99+' : String(n);
    btn.classList.add('has-alert');
    btn.setAttribute('data-undelivered', String(n));
  } else {
    if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
    btn.classList.remove('has-alert');
    btn.removeAttribute('data-undelivered');
  }
}
async function refreshUndelivered() {
  try {
    const q = await api.mailboxQueue('delivered0', 99);
    if (!q || q.available === false) { applyDockBadge(null); return; }
    applyDockBadge(typeof q.count === 'number' ? q.count : 0);
  } catch { applyDockBadge(null); }
}
// v6.53 涟漪流含雷影：事件去重键含 sessionId/role（多来源同 at 同 type 不再误合）
function evKey(it) {
  const d = (it && it.data) || {};
  if (d.msgId != null) return 'mbox|' + d.msgId;   // v6.53：同 msgId（实时/历史/聚合）视为同一条——防出站派活重复上屏
  return [it && it.at, it && it.type, d.sessionId, d.role].join('|');
}
// 合并去重 + 按 at 降序 + 上限 200（聚合 items 与本地实时事件共用；空数组则原样不动）
function mergeEvents(items) {
  const src = Array.isArray(items) ? items : [];
  if (!src.length) return;
  const seen = new Set(store.events.map(evKey));
  // 宽松键兜底：实时 SSE 事件可能未带 role、聚合事件带 role → 再比 (at|type|sessionId) 防同事件重复条
  const _loose = (it) => { const d = (it && it.data) || {}; return d.msgId != null ? ('mbox|' + d.msgId) : [it && it.at, it && it.type, d.sessionId].join('|'); };
  const seenLoose = new Set(store.events.map(_loose));
  const merged = store.events.slice();
  for (const it of src) {
    if (!it) continue;
    const k = evKey(it);
    if (seen.has(k) || seenLoose.has(_loose(it))) continue;
    merged.push(it); seen.add(k); seenLoose.add(_loose(it));
  }
  merged.sort((a, b) => (Number(b && b.at) || 0) - (Number(a && a.at) || 0));   // 显式按 at 降序（新在前）
  store.events = merged.slice(0, 200);
}
// 拉取聚合事件流（主我 + 关联雷影）；端点未就绪/失败 → 静默降级（沿用现有本地事件），绝不报错
async function loadAggEvents() {
  try {
    const r = await api.eventsAggregate(store.currentId || null);
    if (r && Array.isArray(r.items)) mergeEvents(r.items);
  } catch { }
}
// v6.1.2：启动时加载持久化的涟漪事件历史（重开不清零）。仅 boot 调一次，避免覆盖实时新增。
async function loadEventHistory() {
  try {
    const h = await api.eventsHistory(500);
    if (h && Array.isArray(h.items) && h.items.length) {
      // 历史（倒序，新在前）与本地实时事件合并去重 + 按 at 降序 + 上限 200（v6.53 键含 sessionId/role）
      mergeEvents(h.items);
    }
  } catch { }
}
async function openSession(id) {
  if (!id) return;
  const prev = store.currentId;
  if (prev && prev !== id) clearInbound(prev);   // 切换会话：清空上一个会话的实时气泡（防内存累积/误挂）
  store.currentId = id;
  try {
    const s = await api.session(id);
    store.messages[id] = (s.messages || []).map(normalizeMsg);
    // 兜底：用会话 detail 的最新 model/effort 回填列表项（防列表读到未及时落盘的旧值 → 选择器显示旧模型）
    const _it = (store.sessions || []).find((x) => x.id === id);
    if (_it) { _it.model = s.model ?? null; _it.reasoningEffort = s.reasoningEffort ?? null; }
    clearInbound(id);   // 载入历史后由历史标记接管，实时气泡清空（防残留）
    if (s.stats) {
      store.sessionStats = s.stats;   // v6.21：冷启动/切会话即填右栏「运行指标」，消除最长 15s 空白（零新增请求）
      store.nexus.used = s.stats.usedTokens || 0; store.nexus.budget = s.stats.contextBudget || store.nexus.budget; store.gen[id] = s.stats.gen || '';   // v6.53c：代数单源——stats.gen（归档权威），不再用 compactions
    }
  } catch { }
  // 实时态势曲线：切会话时若本地无该会话 turn 历史 → 从事件历史（/api/events/history）回填
  if (!store.historyBySession[id]) {
    try {
      const h = await api.eventsHistory(500);
      const pts = [];
      if (h && Array.isArray(h.items)) {
        for (const it of h.items.slice().reverse()) {   // 倒序(新在前) → 反转为时间正序
          if (it && it.type === 'turn-done' && it.data && it.data.sessionId === id) {
            const pt = normalizeTurnUsage(it.data.usage, it.at);
            if (pt) pts.push(pt);
          }
        }
      }
      setTurnHistory(id, pts);
    } catch { }
  }
  updateStatus(); updateCorePulse();   // F2：currentId 变化同步状态栏/池心
  if (window.__leizaiReloadSessionAgents) { try { window.__leizaiReloadSessionAgents(); } catch { } }   // 本会话雷影栏：切换会话即刷新
  if (window.__leizaiAskBoxRefresh) { try { window.__leizaiAskBoxRefresh(); } catch { } }   // 询问卡片：切会话清理他会话卡片 + 恢复本会话未答
  if (window.__leizaiScopeRefresh) { try { window.__leizaiScopeRefresh(); } catch { } }   // 模型/推理等级控件：切会话刷新为该会话值
  loadAggEvents();   // v6.53：切会话 → 刷新含雷影的聚合涟漪事件（静默降级，不 await 阻塞 UI）
}

// —— 会话级预算同步钩子（供 sse.js 在「回合结束 / compacted 交接」时调用，避免循环 import）——
// 把最新 stats 的 usedTokens/contextBudget 写回 store.nexus 并重绘进度条 + 状态栏。
function syncBudget(stats) {
  if (!stats) return;
  if (typeof stats.usedTokens === 'number') store.nexus.used = stats.usedTokens;
  if (typeof stats.contextBudget === 'number' && stats.contextBudget > 0) store.nexus.budget = stats.contextBudget;
  updateCorePulse();   // 同步池心脉冲环与状态栏
  updateStatus();
}

// —— 池心脉冲环（#core-pulse 不挂载：命令式更新属性，保留美工 SVG）——
function updateCorePulse() {
  const el = document.getElementById('core-pulse'); if (!el) return;
  const used = store.nexus.used || 0, budget = store.nexus.budget || 150000;
  const p = budget > 0 ? Math.min(100, Math.round(used / budget * 100)) : 0;
  el.style.setProperty('--pct', p);
  el.dataset.activity = Object.values(store.running).some(Boolean) ? 'thinking' : (store.events.length ? 'busy' : 'idle');
  el.dataset.level = p >= 90 ? 'err' : p >= 70 ? 'warn' : 'ok';
  const pctEl = document.getElementById('core-pulse-pct'); if (pctEl) pctEl.textContent = p + '%';
  const sub = document.getElementById('core-pulse-sub');
  if (sub) sub.textContent = Math.round(used / 1000) + 'k / ' + Math.round(budget / 1000) + 'k · 命中 ' + (((store.stats && store.stats.cacheHitRate) || 0) * 100).toFixed(0) + '%';
  // 空生态引导（P-3）
  const empty = document.getElementById('nexus-empty');
  if (empty) {
    const hasAgents = (store.mailbox && store.mailbox.roles && store.mailbox.roles.length > 1);
    const hasSessions = (store.sessions || []).length > 0;
    empty.hidden = !!(hasAgents || hasSessions);
  }
}

function updateStatus() {
  const t = document.getElementById('status-text'); if (t) t.textContent = '就绪';
  const sm = document.getElementById('status-mode'); if (sm) sm.textContent = (store.mode === 'classic' ? '经典' : '全景') + ' · ' + store.view;
  const ss = document.getElementById('status-session'); if (ss) ss.textContent = store.currentId || '—';
  const sc = document.getElementById('status-conn');
  if (sc) {
    // 任务B：从 "SSE 已连接" 扩展为 "SSE 已连接 · 模型正常/异常"（异常时红色）
    let llmTag = '';
    if (store.llm && store.llm.ok === false) llmTag = ' · <span class="status-conn__llm status-conn__llm--err">模型异常</span>';
    else if (store.llm && store.llm.ok === true) llmTag = ' · <span class="status-conn__llm">模型正常</span>';
    sc.innerHTML = '<span class="dot ' + (store.connected ? 'dot-online' : 'dot-error') + '"></span> SSE ' + (store.connected ? '已连接' : '断开') + llmTag;
  }
}

// —— 命令面板（Ctrl+K）——
const CMDS = [
  { label: '前往 中枢', kbd: '1', berth: 'nexus', icon: '/assets/icon-nexus.svg' },
  { label: '前往 核心', kbd: '2', berth: 'core', icon: '/assets/icon-core.svg' },
  { label: '前往 雷影', kbd: '3', berth: 'dock', icon: '/assets/icon-dock.svg' },
  { label: '前往 自省', kbd: '4', berth: 'mirror', icon: '/assets/icon-mirror.svg' },
  { label: '前往 任务坊', kbd: '5', berth: 'forge', icon: '/assets/icon-forge.svg' },
  { label: '前往 控制台', kbd: '6', berth: 'console', icon: '/assets/icon-console.svg' },
  { label: '新建会话', kbd: '⌘N', action: 'new-session', icon: '/assets/ui-plus.svg' },
  { label: '收拢窗口 / 交接换代', action: 'handoff', icon: '/assets/ui-archive.svg' },
  { label: '刷新数据', action: 'refresh', icon: '/assets/ui-play.svg' },
];
function buildPalette(q) {
  q = (q || '').toLowerCase();
  const items = [];
  for (const c of CMDS) if (!q || c.label.toLowerCase().includes(q)) items.push(c);
  for (const s of (store.sessions || []).slice(0, 40)) if (!q || ((s.title || '') + s.id).toLowerCase().includes(q)) items.push({ label: '会话：' + (s.title || s.id), session: s.id, icon: '/assets/icon-core.svg' });
  for (const r of (store.mailbox.roles || [])) if (!q || (r.name || r.role).toLowerCase().includes(q)) items.push({ label: '雷影：' + (r.name || r.role), role: r.role, icon: '/assets/icon-dock.svg' });
  store.palette.items = items.slice(0, 40);
  store.palette.idx = 0;
}
function openPalette() { store.palette.open = true; const m = document.getElementById('palette-mask'); if (m) m.classList.add('is-open'); const i = document.getElementById('palette-input'); if (i) { i.value = ''; i.focus(); } buildPalette(''); }
function closePalette() { store.palette.open = false; const m = document.getElementById('palette-mask'); if (m) m.classList.remove('is-open'); }
function runPalette() {
  const it = store.palette.items[store.palette.idx]; if (!it) return;
  if (it.berth) setBerth(it.berth);
  else if (it.session) { openSession(it.session); setBerth('core'); }
  else if (it.role) setBerth('dock');
  else if (it.action === 'new-session') newSession();
  else if (it.action === 'refresh') { loadGlobals(); reloadSessions(); }
  else if (it.action === 'handoff') doHandoff(false);
  closePalette();
}

// 新建会话：先弹标题输入框，确认后才真正创建（取消/空标题回落默认）
function newSession() {
  store.modal = {
    title: '新建会话', kind: 'prompt', okText: '创建',
    input: { value: '新会话', placeholder: '输入会话标题（默认：新会话）' },
    onOk(v) { createSessionWithTitle(v); },
  };
}
async function createSessionWithTitle(v) {
  const title = String(v == null ? '' : v).trim() || '新会话';
  try {
    const r = await api.createSession({ title });
    await reloadSessions();
    if (r && r.id) { await openSession(r.id); setBerth('core'); warmupSession(r.id, title); }
  } catch (e) { toast('新建失败: ' + e.message, 'err'); }
}
// 建会话后预热：发一条与标题相关的开场消息，触发引擎跑一轮 → 建立该会话缓存前缀（失败静默降级）
let _warmupSid = null;   // 防同一会话重复预热
function warmupSession(sid, title) {
  if (!sid || _warmupSid === sid) return;
  _warmupSid = sid;
  const text = '（新会话已就绪 · 标题「' + title + '」）请用一句话简短回应这个标题，作为本会话的开场。';
  try {
    ensureMessages(sid);                       // 确保 store.messages[sid] 存在
    store.messages[sid].push(normalizeMsg({ role: 'user', content: text }));
    chat(sid, text, { quiet: true });          // 触发一轮真实请求 → 建立缓存前缀
  } catch (e) { /* 预热失败静默降级，绝不影响建会话 */ }
}

// —— 首次引导（只弹一次；localStorage leizai.onboarded） ——
const ONBOARD_MD = [
  '雷仔是运行在你自己电脑上的智能体：能读写文件、执行命令、联网搜索、自我进化，还能派「雷影」分身分工干活。',
  '',
  '## 会话是怎么工作的',
  '**1. 一个会话 = 一个项目** —— 每个会话有独立项目文件夹与进度账本，你的需求/决定/产物都沉淀在里面，随时可查。',
  '**2. 上下文窗口 = 模型的"工作台"** —— 每轮对话，雷仔把「系统规则 + 工具说明 + 对话历史」一起交给大模型。工作台大小有上限（本会话的"预算"），装满了就要腾地方。',
  '**3. 世代交接 = 不会忘事的清理** —— 窗口快满时自动把旧内容归档（可随时召回），重建干净工作台继续干。聊得再久上下文都不会丢，只是把旧的存进"档案室"。',
  '**4. 缓存前缀 = 越用越省的关键** —— 「系统规则 + 工具说明」稳定不变，会被模型缓存；命中部分费用仅未命中的约十分之一。',
  '**5. 长期记忆** —— 重要认知写入长期记忆，跨会话可用，换会话也不会忘记你。',
  '**6. 雷影 = 专业分身** —— 专精任务（写代码/做设计/查资料/测试）由主我派对应雷影执行，你只需跟主我对话。',
  '',
  '## 你可以这样用',
  '- 直接说需求："帮我看看这个文件""查一下 XX""做个方案"',
  '- 会话标题就是项目名，起个好名字便于日后找回',
].join('\n');

function showOnboarding() {
  store.modal = {
    title: '欢迎使用雷仔', badge: '⚡', wide: true, scroll: true, okText: '开始使用',
    html: ONBOARD_MD,
    onOk() { try { localStorage.setItem('leizai.onboarded', '1'); } catch { } },
  };
}
function maybeOnboard() {
  let seen = null; try { seen = localStorage.getItem('leizai.onboarded'); } catch { }
  if (!seen) showOnboarding();
}
window.__leizaiShowOnboarding = showOnboarding;   // 设置面板「查看引导」入口复用
async function reloadSessions() { try { store.sessions = await api.sessions() || []; } catch { } }
// v6.45：列表刷新防抖——sessions-changed / turn-done 可能短时多发，合并为一次 reload
let _rsTimer = null;
function scheduleReloadSessions(delay = 400) {
  if (_rsTimer) clearTimeout(_rsTimer);
  _rsTimer = setTimeout(() => { _rsTimer = null; try { reloadSessions(); } catch { } }, delay);
}
async function doHandoff(refine) {
  if (!store.currentId) { toast('请先选择会话', 'err'); return; }
  try { const r = await api.handoff(store.currentId, refine); toast('已' + (refine ? '交接换代（含提炼）' : '收拢窗口') + '：丢弃 ' + (r.dropped || 0) + ' 条', 'ok'); await openSession(store.currentId); updateCorePulse(); }
  catch (e) { toast('交接失败: ' + e.message, 'err'); }
}

// —— 全局接线 ——
function wire() {
  document.querySelectorAll('.rail-btn[data-berth]').forEach((x) => x.addEventListener('click', () => setBerth(x.dataset.berth)));
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };

  on('btn-command', 'click', openPalette);
  on('btn-new-session', 'click', newSession);
  on('nexus-refresh', 'click', loadGlobals);
  // 引擎侧会话变更（外部 API 操作）→ 刷新左侧会话列表
  onServerEvent('sessions-changed', () => { scheduleReloadSessions(); if (window.__leizaiScopeRefresh) { try { window.__leizaiScopeRefresh(); } catch { } } });
  onServerEvent('mailbox-message', () => { refreshMailbox(); refreshUndelivered(); });   // v6.9：雷影来信到达即刷角标
  onServerEvent('turn-done', () => { refreshMailbox(); refreshUndelivered(); scheduleReloadSessions(); });   // 回合结束（消息多半已处理）再刷一次；列表需重排（updatedAt 已变）
  // v3.2：SSE 断线重连 → 补拉未读信箱/未送达角标/会话列表（消息本体由 sse.resyncAfterReconnect 补拉）
  onServerEvent('reconnect', () => { refreshMailbox(); refreshUndelivered(); reloadSessions(); });
  window.__leizaiResyncEvents = loadEventHistory;   // 供 sse.resyncAfterReconnect 复用（其自带去重）
  on('vital-notify', 'click', () => setBerth('dock'));
  // —— 右栏（实时态势）开合：宽屏=收起/展开网格列(带过渡)，窄窗=抽屉 is-open；按钮态始终与可见性一致 ——
  function feedWide() { try { return window.matchMedia('(min-width: 1101px)').matches; } catch { return true; } }
  function syncFeedBtn() {
    const btn = document.getElementById('rail-feed-toggle'); if (!btn) return;
    const f = document.getElementById('col-feed'); const ws = document.querySelector('.workspace');
    const on = feedWide() ? !(ws && ws.classList.contains('is-feed-collapsed')) : !!(f && f.classList.contains('is-open'));
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-expanded', String(on));
  }
  function toggleFeed() {
    const f = document.getElementById('col-feed'); if (!f) return;
    if (feedWide()) document.querySelector('.workspace')?.classList.toggle('is-feed-collapsed');
    else f.classList.toggle('is-open');
    syncFeedBtn();
  }
  function closeFeed() {
    if (feedWide()) document.querySelector('.workspace')?.classList.add('is-feed-collapsed');
    else document.getElementById('col-feed')?.classList.remove('is-open');
    syncFeedBtn();
  }
  on('feed-close', 'click', closeFeed);
  on('rail-feed-toggle', 'click', toggleFeed);
  window.addEventListener('resize', syncFeedBtn);
  syncFeedBtn();

  // —— 通讯任务脊侧栏（col-spine）开合：宽屏=grid 列 0↔--spine-w；窄屏=右侧抽屉 is-open（仿 feed）——
  // 默认隐藏；展开/收起由 #rail-spine-toggle 与组件内"点空白关闭"(leizai-spine-close 事件)统一驱动。
  function spineWide() { try { return window.matchMedia('(min-width: 1101px)').matches; } catch { return true; } }
  function syncSpineBtn() {
    const btn = document.getElementById('rail-spine-toggle'); if (!btn) return;
    const ws = document.querySelector('.workspace'); const c = document.getElementById('col-spine');
    const on = spineWide() ? !!(ws && ws.classList.contains('is-spine-open')) : !!(c && c.classList.contains('is-open'));
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-expanded', String(on));
  }
  function toggleSpine() {
    const ws = document.querySelector('.workspace'); const c = document.getElementById('col-spine'); if (!c) return;
    if (spineWide()) ws?.classList.toggle('is-spine-open'); else c.classList.toggle('is-open');
    // 窄屏两右抽屉互斥：开脊则收态势（避免叠加同一侧）
    if (!spineWide() && c.classList.contains('is-open')) { document.getElementById('col-feed')?.classList.remove('is-open'); syncFeedBtn(); }
    syncSpineBtn();
  }
  function closeSpine() {
    const ws = document.querySelector('.workspace'); const c = document.getElementById('col-spine');
    if (spineWide()) ws?.classList.remove('is-spine-open'); else c?.classList.remove('is-open');
    syncSpineBtn();
  }
  on('rail-spine-toggle', 'click', toggleSpine);
  window.addEventListener('resize', syncSpineBtn);
  window.addEventListener('leizai-spine-close', closeSpine);
  syncSpineBtn();
  on('win-min', 'click', () => bridge.window('minimize'));
  on('win-max', 'click', () => bridge.window('maximize'));
  on('win-close', 'click', () => bridge.window('close'));
  on('win-reload', 'click', () => bridge.window('reload'));
  // v6.9：无边框窗口——顶栏整行拖动（位移阈值触发，避免吞掉双击最大化）+ 双击最大化
  const __tb = document.getElementById('titlebar');
  if (__tb) {
    const __isCtrl = (t) => !!(t && t.closest && t.closest('button, a, input, label, .no-drag'));
    __tb.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || __isCtrl(e.target)) return;
      const sx = e.screenX, sy = e.screenY; let started = false;
      const onMove = (ev) => {
        if (started) return;
        if (Math.abs(ev.screenX - sx) > 3 || Math.abs(ev.screenY - sy) > 3) {
          started = true; cleanup(); bridge.window('drag').catch(() => { });
        }
      };
      const cleanup = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', cleanup); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', cleanup);
    });
    __tb.addEventListener('dblclick', (e) => { if (!__isCtrl(e.target)) bridge.window('maximize').catch(() => { }); });
  }
  const modeBtn = document.getElementById('mode-toggle');
  if (modeBtn) modeBtn.addEventListener('click', () => {
    store.mode = store.mode === 'nexus' ? 'classic' : 'nexus';
    try { localStorage.setItem('leizai.mode', store.mode); } catch { }
    const lbl = modeBtn.querySelector('[data-field="modeLabel"]'); if (lbl) lbl.textContent = store.mode === 'classic' ? '经典' : '全景';
    document.getElementById('app')?.classList.toggle('mode-classic', store.mode === 'classic');
    updateStatus();
  });
  if (store.mode === 'classic') { const lbl = modeBtn && modeBtn.querySelector('[data-field="modeLabel"]'); if (lbl) lbl.textContent = '经典'; document.getElementById('app')?.classList.add('mode-classic'); }

  const search = document.getElementById('session-search');
  if (search) search.addEventListener('input', () => { store.sessionQuery = search.value; });

  // 会话列表点击已在组件内处理；这里监听其派发的切舱事件
  window.addEventListener('leizai-open-berth', (e) => setBerth(e.detail));
  // F1：sessions.js/core.js 的 pick() 派发本事件 → 由 app.js 统一拉取消息（openSession）
  window.addEventListener('leizai-open-session', (e) => { const id = e.detail && e.detail.id; if (id) openSession(id); });

  // 命令面板输入
  const pi = document.getElementById('palette-input');
  if (pi) {
    pi.addEventListener('input', () => buildPalette(pi.value));
    pi.addEventListener('keydown', (e) => {
      const items = store.palette.items;
      if (e.key === 'ArrowDown') { store.palette.idx = (store.palette.idx + 1) % Math.max(1, items.length); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { store.palette.idx = (store.palette.idx - 1 + items.length) % Math.max(1, items.length); e.preventDefault(); }
      else if (e.key === 'Enter') { runPalette(); e.preventDefault(); }
      else if (e.key === 'Escape') closePalette();
    });
  }
  const pl = document.getElementById('palette-list');
  if (pl) pl.addEventListener('click', (e) => { const it = e.target.closest('.palette__opt'); if (it) { store.palette.idx = +it.dataset.idx; runPalette(); } });
  const mask = document.getElementById('palette-mask');
  if (mask) mask.addEventListener('click', (e) => { if (e.target === mask) closePalette(); });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { closePalette(); }
    if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); store.palette.open ? closePalette() : openPalette(); return; }
    if (mod && e.key >= '1' && e.key <= '6') { e.preventDefault(); setBerth(BERTHS[+e.key - 1]); return; }
    if (mod && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newSession(); return; }
    if (mod && e.key === ',') { e.preventDefault(); setBerth('console'); return; }
    if (mod && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleFeed(); return; }
  });

  // 交接按钮事件桥（chat 组件派发）
  window.addEventListener('leizai-handoff', (e) => doHandoff(!!(e.detail && e.detail.refine)));
}

// —— 启动 ——
async function boot() {
  mountAll();
  initComposer();
  initAskBox();   // 询问选项框（美工）：订阅 ask-user + 恢复未答卡片
  initScopeSelect();   // 会话级模型/推理等级选择器（美工）：发送按钮左侧
  initClassicToggles();
  initRoleDispatchToggle();   // 雷影协同开关（自动领域分流总开闭）
  initSessionTreeButton();    // 会话树入口（核心舱头部 → 本会话泳道图浮层）
  initSubtabs();
  wire();
  startGlobalEvents();
  // 任务B：模型服务探活（首屏 + 每 60s）+ 常驻横幅初始化
  try { initLlmStatus(); } catch { }
  // A1 动效降级接线：系统 prefers-reduced-motion → store.reducedMotion + #app 降级类
  //   （CSS 侧 themes/components/boot-splash 已备好降级规则，此前 JS 从未接线 → 永不生效）
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = (on) => {
      setReducedMotion(!!on);
      const app = document.getElementById('app');
      if (app) app.classList.toggle('no-motion', !!on);
    };
    applyMotion(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', (e) => applyMotion(e.matches));
    else if (mq.addListener) mq.addListener((e) => applyMotion(e.matches));   // 旧内核兼容
  } catch { }
  window.addEventListener('leizai-llm-probe', () => { try { updateStatus(); } catch { } });

  window.__leizaiSyncBudget = syncBudget;
  // v6.10 热重载：向客户端外壳暴露"页面是否正在流式回复"的查询（壳据此延后 Reload，防冲断进行中的回复）
  window.__leizaiFrontBusy = function () {
    try {
      const anyRun = Object.values(store.running || {}).some(Boolean);
      const anyBg = Object.values(store.bgRunning || {}).some(Boolean);
      return !!(anyRun || anyBg);
    } catch (e) { return false; }
  };   // 供 sse.js 在回合结束/交接时同步会话预算并重绘
  await loadGlobals();
  refreshUndelivered();   // v6.12：启动即拉一次未送达角标
  // v6.51⑤：涟漪历史/聚合事件非首屏关键 → 并行启动、不阻塞会话加载
  const _histP = Promise.allSettled([loadEventHistory(), loadAggEvents()]);
  // v6.53：涟漪流含雷影——15s 拉一次聚合事件流（与 links/态势同频；页面隐藏跳过；端点未就绪静默降级）
  setInterval(() => { if (typeof document !== 'undefined' && document.hidden) return; loadAggEvents(); }, 15000);
  await reloadSessions();
  if (!store.currentId && store.sessions.length) await openSession(store.sessions[0].id);
  if (window.__leizaiScopeRefresh) { try { window.__leizaiScopeRefresh(); } catch { } }   // 会话列表就绪后刷新选择器
  // v6.51⑤：首屏可用即交还遮罩（引擎就绪由 boot-splash 的 health 门控判定），不再等历史/聚合
  // v6.55：主界面首帧信号 → 外壳据此撤本地 splash 层（替代已移除的 __bootReady / CSS 遮罩）
  try {
    const _paint = () => { try { bridge.post('uiPainted', { ts: Date.now() }); } catch (e) { } };
    if (window.requestAnimationFrame) window.requestAnimationFrame(() => window.requestAnimationFrame(_paint));
    else setTimeout(_paint, 0);
  } catch (e) { }

  // 周期刷新：态势/统计（含当前会话预算兜底同步——用轻量 stats 端点，不拉全量消息）
  setInterval(async () => {
    try { store.stats = await api.stats(); } catch { }
    try { store.health = await api.health(); } catch { }
    if (store.currentId) {
      try {
        const st = await api.sessionStats(store.currentId);
        store.sessionStats = st;   // 右栏"运行指标"：会话级
        if (window.__leizaiSyncBudget && st) window.__leizaiSyncBudget(st);
      } catch { }
    }
    updateCorePulse(); updateStatus();
  }, 15000);

  // v6.11 未读角标周期兜底：显式独立轮询（SSE 保实时、周期保兜底，二者并存不冲突）。
  // 页面隐藏时跳过以省资源；refreshMailbox 复用既有实现（拉 /api/mailbox/summary）。
  setInterval(() => { try { if (typeof document !== 'undefined' && document.hidden) return; refreshMailbox(); refreshUndelivered(); } catch { } }, 15000);

  // 余额：后端已 60s 缓存，前端 60s 刷一次即可（顶栏展示）
  setInterval(async () => { try { store.balance = await api.balance(); } catch { } }, 60000);

  // 事件 → 更新池心/年轮
  // 媒体交互（P0）：链接/图片/视频/本地文件路径 —— 全局委托 + 本地媒体水合
  initMediaInteract();
  window.addEventListener('leizai-bridge', () => { });
  updateStatus(); updateCorePulse();
  console.log('[A1] 前端已启动', { bridge: bridge.available });
  try { await _histP; } catch { }   // v6.51⑤：历史/聚合收尾（不阻塞遮罩）
  maybeOnboard();   // 首次使用 → 引导窗（仅一次）
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
