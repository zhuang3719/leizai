// A1 前端 · 雷影舱（挂载 #agent-wall / #mail-timeline / #dispatch-panel）——多根渲染
import { defineComponent, computed, ref, onMounted } from 'vue';
import { api } from '../api.js';
import { store, toast, roleBusy } from '../store.js';
import { roleMeta, ROLE_META, hhmm } from '../roles.js';
import { Timeline } from '../components/timeline.js';

// 显示名统一为「雷影·X」（前端注册表为准）；注册表无此角色 → 回退后端名/role
function roleLabel(r) { return ROLE_META[r.role] ? ROLE_META[r.role].name : (r.name || r.role); }

// 雷影卡片墙（挂载 #agent-wall；host 已是 .card-grid）
export const AgentWall = defineComponent({
  name: 'AgentWall',
  setup() {
    const selected = ref(null);
    async function load() {
      try { const s = await api.mailboxSummary(); store.mailbox = { roles: s.roles || [], totalUnread: s.totalUnread || 0 }; }
      catch { }
    }
    onMounted(load);
    window.__leizaiReloadAgents = load;
    function pick(r) {
      selected.value = r.role;
      window.dispatchEvent(new CustomEvent('leizai-mail-role', { detail: r.role }));
      window.__leizaiLoadMail && window.__leizaiLoadMail(r.role);
    }
    const roles = computed(() => store.mailbox.roles || []);
    function meta(r) { return roleMeta(r.role); }
    // v6.48：显示名统一为「雷影·X」（前端注册表为准）；注册表无此角色 → 回退后端名/role
    return { roles, selected, pick, meta, label: roleLabel, roleBusy };
  },
  template: `
    <div v-for="r in roles" :key="r.role"
         :class="['card', 'card--hover', 'is-clickable', 'agent-card', meta(r).cls, { 'is-active': r.role === selected }]"
         :data-role="r.role" @click="pick(r)">
      <div class="card__head">
        <span class="avatar"><span class="role-icon" :style="{ '--icon': 'url(' + meta(r).icon + ')' }"></span></span>
        <div>
          <div class="card__title">{{ label(r) }}</div>
          <div class="agent-card__meta">
            <span class="dot" :class="roleBusy(r.role) ? 'dot-busy' : 'dot-online'"></span>
            <span class="mono">{{ (r.baseUrl || '').replace('http://127.0.0.1', ':') || '—' }}</span>
          </div>
        </div>
        <span v-if="r.unread" class="badge" style="margin-left:auto;">{{ r.unread }}</span>
      </div>
      <div class="agent-card__domain"><span class="chip">{{ r.domain || r.role }}</span><span v-if="r.isMain" class="chip chip--acc">主我</span></div>
      <div class="card__sub" style="margin-top:8px;">{{ r.unread ? ('未读 ' + r.unread + ' 条') : '无未读' }}</div>
    </div>
    <div v-if="!roles.length" class="empty"><div class="empty__text">未发现雷影实例（后端 or 信箱未就绪）</div></div>
  `,
});

// 信箱时间线（挂载 #mail-timeline；host 已是 .timeline）
export const MailTimeline = defineComponent({
  name: 'MailTimeline',
  components: { Timeline },
  setup() {
    const role = ref('');
    async function loadMail(r) {
      role.value = r || role.value;
      try { const m = await api.mailbox(role.value); store.mailboxCurrent = { role: role.value, entries: m.entries || [], available: m.available !== false }; }
      catch { store.mailboxCurrent = { role: role.value, entries: [], available: false }; }
    }
    onMounted(() => { window.__leizaiLoadMail = loadMail; });
    window.addEventListener('leizai-mail-role', (e) => loadMail(e.detail));
    const items = computed(() => {
      const cur = store.mailboxCurrent || {};
      return (cur.entries || []).map((m) => ({
        id: m.id, type: m.type || 'notify', role: m.from_id || 'main',
        text: m.topic || m.content || '', time: hhmm(m.ts),
        // 只把"真正未读的 task"标红：reply/ack/notify 等本不需回执、或已有 read_at 的不标
        unread: !m.read_at && m.type === 'task',
      }));
    });
    const available = computed(() => !(store.mailboxCurrent && store.mailboxCurrent.available === false));
    return { items, available };
  },
  template: `
    <Timeline :items="items" />
    <div v-if="!available" class="dim" style="font-size:12px;margin-top:6px;">⚠ 信箱端点未就绪或未初始化</div>
  `,
});

// 派活面板（挂载 #dispatch-panel；host 已是 .card）
export const DispatchPanel = defineComponent({
  name: 'DispatchPanel',
  setup() {
    const toRole = ref('programmer');
    const type = ref('task');
    const text = ref('');
    const busy = ref(false);
    const roles = computed(() => (store.mailbox.roles || []).length ? store.mailbox.roles : [
      { role: 'programmer', name: '程序员' }, { role: 'designer', name: '美工' }, { role: 'writer', name: '文案' },
      { role: 'tester', name: '测试' }, { role: 'researcher', name: '研究员' }, { role: 'sales', name: '销售' },
    ]);
    async function send() {
      if (!text.value.trim()) { toast('请输入派活内容', 'err'); return; }
      busy.value = true;
      try {
        const r = await api.mailboxSend({ toRole: toRole.value, type: type.value, content: text.value.trim() });
        toast('已派发 → ' + toRole.value + (r.id ? ' (' + r.id + ')' : ''), 'ok');
        text.value = '';
      } catch (e) { toast('派发失败: ' + e.message, 'err'); }
      finally { busy.value = false; }
    }
    return { toRole, type, text, busy, roles, send, label: roleLabel };
  },
  template: `
    <div class="card__title" style="margin-bottom:8px;">派活</div>
    <div class="card-list">
      <select class="select" v-model="toRole" aria-label="目标雷影">
        <option v-for="r in roles" :key="r.role" :value="r.role">● {{ label(r) }}</option>
      </select>
      <select class="select" v-model="type" aria-label="消息类型">
        <option value="task">task</option><option value="reply">reply</option><option value="notify">notify</option>
      </select>
      <textarea class="input" v-model="text" rows="4" style="height:auto;padding:8px;min-width:0;width:100%;" placeholder="派活内容…"></textarea>
      <button class="btn btn--primary" :disabled="busy" @click="send">{{ busy ? '发送中…' : '发送' }}</button>
    </div>
  `,
});
