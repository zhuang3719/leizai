// A1 前端 · 控制台（挂载 #settings-nav / #settings-form）——多根渲染
import { defineComponent, ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { store, toast } from '../store.js';

export const SettingsNav = defineComponent({
  name: 'SettingsNav',
  setup() {
    const cur = ref('model');
    function pick(p) { cur.value = p; window.dispatchEvent(new CustomEvent('leizai-settings-pane', { detail: p })); }
    return { cur, pick };
  },
  template: `
    <button class="subtab" :class="{ 'is-active': cur==='model' }" data-pane="model" @click="pick('model')">大模型配置</button>
    <button class="subtab" :class="{ 'is-active': cur==='perm' }" data-pane="perm" @click="pick('perm')">权限</button>
    <button class="subtab" :class="{ 'is-active': cur==='backend' }" data-pane="backend" @click="pick('backend')">后端与数据</button>
    <button class="subtab" :class="{ 'is-active': cur==='pro' }" data-pane="pro" @click="pick('pro')">Pro 激活</button>
    <button class="subtab" :class="{ 'is-active': cur==='about' }" data-pane="about" @click="pick('about')">关于</button>
  `,
});

export const SettingsForm = defineComponent({
  name: 'SettingsForm',
  setup() {
    const cfg = ref({}); const balance = ref(null); const pane = ref('model');
    // P0-3：Pro 激活入口（输入激活码 → /api/pro/activate → 显示档位/结果）
    const proState = ref(null); const licInput = ref(''); const activating = ref(false);
    async function loadPro() { try { proState.value = await api.get('/api/pro/status'); } catch (e) { proState.value = { error: e.message }; } }
    async function doActivate() {
      const key = String(licInput.value || '').trim();
      if (!key) { toast('请输入激活码', 'err'); return; }
      activating.value = true;
      try {
        const r = await api.post('/api/pro/activate', { licenseKey: key });
        if (r && r.ok) { toast('激活成功 · 档位 ' + (r.tier || 'pro'), 'ok'); licInput.value = ''; }
        else { toast('激活失败：' + ((r && r.error) || 'unknown'), 'err'); }
      } catch (e) { toast('激活失败：' + e.message, 'err'); }
      finally { activating.value = false; await loadPro(); }
    }
    // v1：行内保存状态——选择类（开关/下拉）即时保存后闪「已保存 ✓」；输入类改动后显「未保存」
    const dirty = ref(false);
    const savedTip = ref(false);
    let _tipTimer = null;
    function markDirty() { dirty.value = true; savedTip.value = false; }
    function markSaved() { dirty.value = false; savedTip.value = true; if (_tipTimer) clearTimeout(_tipTimer); _tipTimer = setTimeout(() => { savedTip.value = false; }, 1600); }
    const budgetInput = ref(null);   // 预算输入框（模板 ref，供显式「保存」按钮取值）
    window.addEventListener('leizai-settings-pane', (e) => { pane.value = e.detail; if (e.detail === 'model') loadUsage(); if (e.detail === 'pro') loadPro(); });
    // —— 控制台·提供商表单（最小集）：提供商切换 / API Key / 模型 ——
    //   安全约定：key 只进不出——输入框永不从 cfg 回填；读到的明文 apiKeys 只转成"是否已设置"布尔后立即从内存抹除。
    const providers = ref([]);
    const curProvider = ref('');
    const autoSwitchTip = ref(false);   // 切换提供商后自动校正模型时，提示说明
    const curBaseURL = ref('');
    const keyVal = ref('');            // 仅存"用户本次新输入"，保存后即清空
    const keyPresence = ref({});       // provider -> 是否已配置 key（布尔，非明文）
    // —— 高级设置（本次补充）：温度 / 工作目录 / Python 路径 ——
    let loadedAdvanced = false;
    const curTemp = ref(0.3);
    const curWorkdir = ref('');
    const curPythonPath = ref('');
    const provObj = (k) => (providers.value || []).find((x) => x.key === k) || null;
    const keyPlaceholder = computed(() => keyPresence.value[curProvider.value] ? '已设置（留空保持）' : '请输入 API Key');
    // 模型候选：当前提供商内置模型 ∪ 配置里的模型（去重、保序、非空）——随提供商切换自动刷新
    const modelOptions = computed(() => {
      const o = provObj(curProvider.value);
      const list = [...((o && o.models) || []), ...((cfg.value.models) || [])];
      return [...new Set(list.filter(Boolean))];
    });
    function saveModel() { const m = String(cfg.value.model || '').trim(); if (!m) return; cfg.value.model = m; save({ model: m }); }
    // 模型组合框（可自由输入 + 下拉候选）：弹层 Teleport 到 body + fixed，避免被面板 overflow 裁剪
    const modelOpen = ref(false);
    const modelHi = ref(-1);
    const modelCombo = ref(null);
    const modelPopupStyle = ref({});
    function onWinScroll() { modelOpen.value = false; window.removeEventListener('scroll', onWinScroll, true); }
    function closeModel() { modelOpen.value = false; window.removeEventListener('scroll', onWinScroll, true); }
    function closeModelSoon() { setTimeout(closeModel, 140); }
    function openModel() {
      const el = modelCombo.value;
      if (el && el.getBoundingClientRect) {
        const r = el.getBoundingClientRect();
        modelPopupStyle.value = { position: 'fixed', left: r.left + 'px', top: (r.bottom + 4) + 'px', width: r.width + 'px' };
      }
      modelOpen.value = true; modelHi.value = -1;
      window.addEventListener('scroll', onWinScroll, true);
    }
    function toggleModel() { if (modelOpen.value) closeModel(); else openModel(); }
    function pickModel(m) { if (!m) return; cfg.value.model = m; saveModel(); closeModel(); }
    function onModelKey(e) {
      const list = modelOptions.value, n = list.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!modelOpen.value) openModel(); else modelHi.value = n ? (modelHi.value + 1) % n : -1; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (modelOpen.value && n) modelHi.value = (modelHi.value - 1 + n) % n; }
      else if (e.key === 'Enter') { e.preventDefault(); if (modelOpen.value && modelHi.value >= 0 && n) pickModel(list[modelHi.value]); else { saveModel(); modelOpen.value = false; } }
      else if (e.key === 'Escape') { modelOpen.value = false; }
    }
    function extractKeyPresence() {
      const pres = {};
      try {
        const ak = cfg.value && cfg.value.apiKeys;
        if (ak && typeof ak === 'object') for (const k of Object.keys(ak)) pres[k] = !!ak[k];
        if (cfg.value && cfg.value.provider) pres[cfg.value.provider] = pres[cfg.value.provider] || !!cfg.value.apiKey;
      } catch { }
      // 关键：立即从内存中的 cfg 抹掉明文 apiKeys / 掩码 apiKey，避免被渲染或整份回传
      try { if (cfg.value) { delete cfg.value.apiKeys; delete cfg.value.apiKey; } } catch { }
      keyPresence.value = pres;
    }
    async function load() {
      try { cfg.value = await api.config(); } catch { }
      try { balance.value = await api.balance(); } catch { }
      try { providers.value = (await api.providers()) || []; } catch { }
      extractKeyPresence();
      if (!curProvider.value) curProvider.value = cfg.value.provider || 'deepseek';
      if (!curBaseURL.value) curBaseURL.value = cfg.value.baseURL || ((provObj(curProvider.value) || {}).baseURL || '');
      if (!loadedAdvanced) {                                   // 首次载入才回填，避免覆盖用户正在编辑的值
        curTemp.value = (cfg.value.temperature !== undefined && cfg.value.temperature !== null) ? cfg.value.temperature : 0.3;
        curWorkdir.value = cfg.value.workdir || '';
        curPythonPath.value = cfg.value.pythonPath || '';
        loadedAdvanced = true;
      }
    }
    onMounted(load);
    // 切换提供商：带出该 provider 的模型候选 + 默认 baseURL + 清空 Key 输入
    function onProviderChange() {
      const o = provObj(curProvider.value);
      curBaseURL.value = (o && o.baseURL) || '';
      const ms = (o && o.models) || [];
      // 切换提供商后：若当前模型不在该提供商候选内且候选非空 → 自动校正为候选首项，
      // 并直接同步到下方「模型」选择（同一个字段 config.model）。
      if (ms.length && !ms.includes(cfg.value.model)) { cfg.value.model = ms[0]; autoSwitchTip.value = true; }
      else autoSwitchTip.value = false;
      keyVal.value = '';
      saveProvider();   // 选择类（提供商）即时保存，与模型/推理级别一致
    }
    // 保存：**只提交本表单字段**（不回传整份 cfg，避免带上掩码串/其它 provider 明文 key）
    async function saveProvider() {
      const key = String(keyVal.value || '').trim();
      const patch = { provider: curProvider.value, model: cfg.value.model, baseURL: curBaseURL.value,
        workdir: String(curWorkdir.value || ''), pythonPath: String(curPythonPath.value || '') };
      // 温度必须为 number（后端 typeof==='number' 校验，字符串会被拒）；非法/NaN 则不提交该字段
      const t = Number(curTemp.value);
      if (Number.isFinite(t) && t >= 0 && t <= 2) patch.temperature = t; else toast('温度需为 0~2 的数字，已跳过', 'info');
      if (key && !key.includes('*')) patch.apiKeys = { [curProvider.value]: key };   // 仅"新填"才提交
      try {
        const r = await api.saveConfig(patch);
        Object.assign(cfg.value, { provider: patch.provider, model: patch.model, baseURL: patch.baseURL,
          workdir: patch.workdir, pythonPath: patch.pythonPath });
        if (patch.temperature !== undefined) cfg.value.temperature = patch.temperature;
        if (patch.apiKeys) keyPresence.value[curProvider.value] = true;
        keyVal.value = '';                                   // 清掉明文
        toast('已保存', 'ok');
        markSaved();
        if (r && r.restartRequired) toast('需重启后端生效', 'info');
        await load();
      } catch (e) { toast('保存失败: ' + e.message, 'err'); }
    }
    async function save(patch) {
      try {
        await api.saveConfig(Object.assign({}, cfg.value, patch)); Object.assign(cfg.value, patch);
        if (patch && patch.contextBudget != null) store.defaultBudget = Number(patch.contextBudget) || 0;   // v1：改全局默认后顶栏「预算」即时跟随
        markSaved();
        toast('已保存', 'ok');
        // 改全局配置后，刷新输入框旁 scope 选择器的 _cfg 缓存（"跟随全局"值/候选列表同步更新）
        if (window.__leizaiScopeReload) { try { await window.__leizaiScopeReload(); } catch { } }
      }
      catch (e) { toast('保存失败: ' + e.message, 'err'); }
    }
    // 会话预算（全局默认）上限校验：与 feed.js 的 BUDGET_MAX 同值
    const BUDGET_MAX = 900000;
    async function saveBudget(v) {
      const val = +v;
      if (!Number.isFinite(val) || val < 1000) { toast('预算需为 ≥1000 的数字', 'err'); resetBudgetInput(); return; }
      if (val > BUDGET_MAX) { toast('预算不能超过 900000（模型上限约 1M，留安全余量）', 'err'); resetBudgetInput(); return; }
      await save({ contextBudget: val });
    }
    function resetBudgetInput() { const cur = cfg.value.contextBudget; const el = document.getElementById('cfg-budget-input'); if (el) el.value = (cur != null ? cur : ''); }
    function showOnboarding() { try { window.__leizaiShowOnboarding && window.__leizaiShowOnboarding(); } catch { } }
    // v1：完全访问权限（危险项）——二次确认
    function toggleFullAccess() {
      const next = !cfg.value.fullAccess;
      const msg = next
        ? '开启「完全访问权限」后，雷仔可读写本机任意路径、执行任意命令。确认开启？'
        : '关闭「完全访问权限」后，雷仔将无法读写本机任意路径。确认关闭？';
      if (!confirm(msg)) return;
      save({ fullAccess: next });
    }
    async function restartBackend() {
      if (!confirm('重启后端会中断所有正在进行的会话（约数秒）。确认重启？')) return;
      try { await api.post('/api/shutdown'); toast('后端已请求重启', 'info'); } catch (e) { toast(e.message, 'err'); }
    }
    // —— 归档容量：当前最大会话占用 + 防误删确认保存 ——
    const usageMax = ref(null);
    const capInput = ref(null);
    async function loadUsage() {
      try { const r = await api.archiveUsage(); usageMax.value = (r && r.maxMB != null) ? r.maxMB : null; }
      catch { usageMax.value = null; }
    }
    onMounted(loadUsage);
    async function saveArchiveCap(v) {
      const val = +v;
      try {
        await api.saveConfig(Object.assign({}, cfg.value, { archiveMaxSizeMB: val }));
        Object.assign(cfg.value, { archiveMaxSizeMB: val }); toast('已保存', 'ok'); loadUsage();
      } catch (e) {
        if (e.status === 409 && e.data && e.data.needConfirm) {
          const mb = e.data.maxSessionMB;
          if (!confirm(`此上限将立即清理超出部分数据（当前最大会话约 ${mb} MB）。继续保存？`)) { const cur = cfg.value.archiveMaxSizeMB; if (capInput.value) capInput.value.value = (cur != null ? cur : ''); return; }
          try {
            await api.saveConfig(Object.assign({}, cfg.value, { archiveMaxSizeMB: val, confirmArchivePrune: true }));
            Object.assign(cfg.value, { archiveMaxSizeMB: val }); toast('已保存（已确认清理）', 'ok'); loadUsage();
          } catch (e2) { toast('保存失败: ' + e2.message, 'err'); }
        } else toast('保存失败: ' + e.message, 'err');
      }
    }
    return { cfg, balance, pane, save, saveBudget, showOnboarding, saveArchiveCap, usageMax, capInput, restartBackend, toggleFullAccess, dirty, savedTip, markDirty, budgetInput, store, load, proState, licInput, activating, doActivate, loadPro,
             providers, curProvider, autoSwitchTip, curBaseURL, keyVal, keyPresence, keyPlaceholder, modelOptions, saveModel, modelOpen, modelHi, modelCombo, modelPopupStyle, openModel, closeModelSoon, toggleModel, pickModel, onModelKey,
             curTemp, curWorkdir, curPythonPath,
             onProviderChange, saveProvider };
  },
  template: `
    <div class="set-lead">
      <span class="icon icon--sm" style="--i:url(/assets/ui-list.svg)"></span>
      <span>首次配置建议：在「大模型配置」里先用「连接凭据」填 <b>API Key</b>、再选<b>模型</b>。下拉点选即生效；输入项改完按「保存设置」。</span>
    </div>
    <template v-if="pane==='model'">
      <div class="set-group">
        <h4 class="set-group__title">连接凭据<span class="set-group__desc">用哪个服务、配哪把钥匙</span><span class="save-state is-ok" v-if="savedTip">已保存 ✓</span></h4>
        <div class="form-row"><div class="form-row__label">提供商</div>
          <div><select class="select" v-model="curProvider" @change="onProviderChange">
            <option v-for="p in providers" :key="p.key" :value="p.key">{{ p.label }}</option>
          </select>
          <div class="form-row__hint">切换提供商会重置接口地址与模型候选，且不回显已保存的 Key。</div>
          <div class="form-row__hint is-ok" v-if="autoSwitchTip">已按新提供商自动切换模型为「{{ cfg.model }}」，可在下方「模型」处查看或更改。</div></div></div>
        <div class="form-row"><div class="form-row__label">API Key</div>
          <div><input class="input" type="password" autocomplete="new-password" v-model="keyVal" :placeholder="keyPlaceholder" @input="markDirty">
            <div class="form-row__hint">留空 = 保持已保存的 Key；Key 只提交、永不回显。</div></div></div>
        <div class="form-row"><div class="form-row__label">接口地址</div>
          <div><input class="input mono" v-model="curBaseURL" placeholder="https://..." @input="markDirty">
            <div class="form-row__hint">调用该服务的接口地址，切换提供商会自动带出默认值。</div></div></div>
      </div>
      <div class="set-group">
        <h4 class="set-group__title">模型与推理<span class="set-group__desc">决定用哪个模型、思考多深</span><span class="save-state is-ok" v-if="savedTip">已保存 ✓</span></h4>
        <div class="form-row"><div class="form-row__label">模型</div>
          <div><div class="combo" ref="modelCombo">
              <input class="input combo__input" type="text" v-model="cfg.model" placeholder="选择或输入型号名"
                @focus="openModel" @click="openModel" @input="modelHi = -1" @change="saveModel" @keydown="onModelKey" @blur="closeModelSoon">
              <button type="button" class="combo__btn" tabindex="-1" aria-label="展开候选" @mousedown.prevent @click="toggleModel">▾</button>
            </div>
            <div class="form-row__hint">当前使用的模型；候选随所选提供商变化，也可直接输入型号名。</div>
            <div class="form-row__hint is-err" v-if="!modelOptions.length">该提供商未内置模型，可直接输入型号名。</div>
            <Teleport to="body">
              <div v-if="modelOpen" class="combo-pop" :style="modelPopupStyle" @mousedown.prevent>
                <div v-if="!modelOptions.length" class="combo-pop__empty">该提供商未内置模型，可直接输入型号名</div>
                <div v-for="(m, i) in modelOptions" :key="m" class="combo-pop__item" :class="{ 'is-hi': i === modelHi }" @click="pickModel(m)">{{ m }}</div>
              </div>
            </Teleport>
          </div></div>
        <div class="form-row"><div class="form-row__label">推理级别</div>
          <div><select class="select" v-model="cfg.reasoningEffort" @change="save({ reasoningEffort: cfg.reasoningEffort })">
            <option value="low">低（推荐 · 快且省）</option><option value="medium">中</option><option value="high">高</option><option value="max">最高</option></select>
            <div class="form-row__hint">越高越聪明、但更贵更慢。<span class="badge-reco">推荐：低</span></div></div></div>
      </div>
      <div class="set-group">
        <h4 class="set-group__title">生成参数<span class="set-group__desc">调用模型的方式</span></h4>
        <div class="form-row"><div class="form-row__label">温度</div>
          <div><input class="input" type="number" step="0.1" min="0" max="2" v-model="curTemp" @input="markDirty">
            <div class="form-row__hint">越低越稳、越高越发散。<span class="badge-reco">推荐：0.3 · 0~2</span></div></div></div>
      </div>
      <div class="set-group">
        <h4 class="set-group__title">预算<span class="set-group__desc">新建会话的默认上下文额度</span></h4>
        <div class="form-row"><div class="form-row__label">全局默认预算</div>
          <div><input ref="budgetInput" id="cfg-budget-input" class="input" type="number" min="1000" max="900000" :value="cfg.contextBudget" @input="markDirty" @keyup.enter="saveBudget(budgetInput && budgetInput.value)">
            <button class="btn btn--sm btn--primary" style="margin-left:8px;" @click="saveBudget(budgetInput && budgetInput.value)">保存</button>
            <span class="save-state" :class="dirty ? 'is-dirty' : (savedTip ? 'is-ok' : '')">{{ dirty ? '未保存' : (savedTip ? '已保存 ✓' : '') }}</span>
            <div class="form-row__hint">新建会话的默认额度（≤900000，约 90W）。<span class="badge-reco">推荐：10W（省）~ 20W（默认）；长链可到 50W+</span>；单个会话可另行覆盖。</div></div></div>
      </div>
      <div class="set-group">
        <h4 class="set-group__title">运行环境<span class="set-group__desc">文件与代码工具落在哪里</span></h4>
        <div class="form-row"><div class="form-row__label">工作目录</div>
          <div><input class="input mono" v-model="curWorkdir" placeholder="文件工具写入目录" @input="markDirty">
            <div class="form-row__hint">文件工具的读写根目录，例如 D:\myproj。</div></div></div>
        <div class="form-row"><div class="form-row__label">Python 路径</div>
          <div><input class="input mono" v-model="curPythonPath" placeholder="python" @input="markDirty">
            <div class="form-row__hint">代码内核所用的 Python，例如 python 或完整路径。</div></div></div>
      </div>
      <div class="set-group">
        <h4 class="set-group__title">余额<span class="set-group__desc">账户可用额度</span></h4>
        <div class="form-row"><div class="form-row__label">余额</div>
          <div><span class="mono console-balance" :class="balance && balance.balance!=null ? (Number(balance.balance)<5?'is-critical':(Number(balance.balance)<20?'is-low':'is-acc')) : 'is-acc'" style="font-size:18px;">{{ balance ? (balance.balance + ' ' + balance.currency) : '—' }}</span>
            <button class="btn btn--sm" style="margin-left:8px;" @click="load">刷新余额</button>
            <div class="form-row__hint">账户可用余额（取不到时显示 —，多为未配置或接口不支持）。</div></div></div>
      </div>
      <div class="set-group">
        <div class="form-row"><div class="form-row__label"></div>
          <div><button class="btn btn--sm btn--primary" @click="saveProvider">保存设置</button>
            <span class="save-state" :class="dirty ? 'is-dirty' : (savedTip ? 'is-ok' : '')">{{ dirty ? '未保存' : (savedTip ? '已保存 ✓' : '') }}</span>
            <span class="form-row__hint" style="margin-left:8px;display:inline;">提交输入项（API Key / 接口地址 / 温度 / 工作目录 / Python 路径）。</span></div></div>
      </div>
    </template>
    <template v-else-if="pane==='perm'">
      <div class="set-group">
        <h4 class="set-group__title">能力开关<span class="set-group__desc">点选即生效</span><span class="save-state is-ok" v-if="savedTip">已保存 ✓</span></h4>
        <div class="form-row"><div class="form-row__label">自动应用进化</div>
          <div><span class="switch" :class="{ 'is-on': cfg.evolutionAutoApply }" @click="save({ evolutionAutoApply: !cfg.evolutionAutoApply })"></span>
            <div class="form-row__hint">开启后，雷仔提出的进化提案将自动批准生效（可回滚）。<em class="dim">内部键 evolutionAutoApply</em></div></div></div>
        <div class="form-row"><div class="form-row__label">开启自我反思</div>
          <div><span class="switch" :class="{ 'is-on': cfg.reflectionEnabled }" @click="save({ reflectionEnabled: !cfg.reflectionEnabled })"></span>
            <div class="form-row__hint">任务结束后自动沉淀记忆与技能。<em class="dim">内部键 reflectionEnabled</em></div></div></div>
      </div>
      <div class="set-group set-group--danger">
        <h4 class="set-group__title">完全访问权限（危险）</h4>
        <div class="form-row"><div class="form-row__label">完全访问权限</div>
          <div><span class="switch is-danger" :class="{ 'is-on': cfg.fullAccess }" @click="toggleFullAccess"></span>
            <div class="form-row__hint is-err">开启后可读写任意路径、执行任意命令；切换前会二次确认。<em class="dim">内部键 fullAccess</em></div></div></div>
      </div>
    </template>
    <template v-else-if="pane==='backend'">
      <div class="set-group set-group--danger">
        <h4 class="set-group__title">后端守护（危险）</h4>
        <div class="form-row"><div class="form-row__label">运行状态</div>
          <div><span class="dot" :class="store.health && store.health.ok ? 'dot-online' : 'dot-error'"></span>
            <span class="mono">PID {{ store.daemon ? store.daemon.pid : '—' }} · :{{ cfg.port || 3458 }}</span>
            <button class="btn btn--sm btn--danger" style="margin-left:8px;" @click="restartBackend">重启后端</button>
            <div class="form-row__hint is-err">重启会中断所有正在进行的会话（约数秒），点击后需二次确认。</div></div></div>
      </div>
      <div class="set-group set-group--danger">
        <h4 class="set-group__title">数据归档（危险）<span class="set-group__desc">超限会清理旧数据</span></h4>
        <div class="form-row"><div class="form-row__label">归档容量上限（单会话）</div>
          <div><input ref="capInput" class="input" type="number" placeholder="2048" :value="cfg.archiveMaxSizeMB" @input="markDirty" @keyup.enter="saveArchiveCap(capInput && capInput.value)">
            <button class="btn btn--sm btn--primary" style="margin-left:8px;" @click="saveArchiveCap(capInput && capInput.value)">保存</button>
            <span class="save-state" :class="dirty ? 'is-dirty' : (savedTip ? 'is-ok' : '')">{{ dirty ? '未保存' : (savedTip ? '已保存 ✓' : '') }}</span>
            <span class="form-row__hint" style="margin-left:6px;">MB</span>
            <div class="form-row__hint">每会话上限（如 2048 = 2GB）；超过后从该会话最旧流水开始清理；0 = 不限制。</div>
            <div class="form-row__hint" v-if="usageMax != null">当前最大会话占用约 {{ usageMax }} MB</div>
            <div class="form-row__hint is-err" v-if="+cfg.archiveMaxSizeMB > 0 && +cfg.archiveMaxSizeMB < 50">⚠ 低于 50MB 不会生效（安全下限），如 1 也不会清理。</div>
            <div class="form-row__hint is-err">调低并保存会立即清理超出的旧数据，需二次确认。</div></div></div>
      </div>
    </template>
    <template v-else-if="pane==='pro'">
      <div class="set-group">
        <h4 class="set-group__title">Pro 激活<span class="set-group__desc">输入激活码解锁 Pro 能力</span></h4>
        <div class="form-row"><div class="form-row__label">当前档位</div>
          <div>
            <span class="mono">{{ proState ? (proState.gate && proState.gate.tier || proState.tier || '—') : '读取中…' }}</span>
            <span class="form-row__hint" style="display:inline;margin-left:8px;" v-if="proState && proState.gate && proState.gate.reason">{{ proState.gate.reason }}</span>
            <div class="form-row__hint" v-if="proState && proState.exp">到期：{{ new Date(proState.exp).toLocaleString() }}</div>
            <div class="form-row__hint" v-if="proState && proState.activated">已激活 · {{ proState.lic || '' }}</div>
            <div class="form-row__hint is-err" v-if="proState && proState.error">{{ proState.error }}</div>
          </div></div>
        <div class="form-row"><div class="form-row__label">激活码</div>
          <div>
            <input class="input" v-model="licInput" placeholder="粘贴激活码（如 XXXX-XXXX-…）" @keyup.enter="doActivate" />
            <button class="btn btn--sm" style="margin-left:8px;" :disabled="activating" @click="doActivate">{{ activating ? '激活中…' : '激活' }}</button>
            <div class="form-row__hint">激活后按 Pro 档运行；Lite 档：有限记忆/技能、无自我进化、限多角色。</div>
          </div></div>
        <div class="form-row"><div class="form-row__label"></div>
          <div><button class="btn btn--ghost btn--sm" @click="loadPro">刷新状态</button></div></div>
      </div>
    </template>
    <template v-else>
      <div class="set-group">
        <h4 class="set-group__title">首次配置建议</h4>
        <div class="form-row"><div class="form-row__label">推荐顺序</div>
          <div><span class="form-row__hint" style="display:inline;">提供商 → API Key → 模型</span>
            <button class="btn btn--sm" style="margin-left:8px;" @click="showOnboarding">查看引导</button>
            <div class="form-row__hint">首次使用可从「查看引导」获得分步说明。</div></div></div>
      </div>
      <div class="set-group">
        <h4 class="set-group__title">关于</h4>
        <div class="form-row"><div class="form-row__label">版本</div><div>雷仔桌面 A1 · P0</div></div>
        <div class="form-row"><div class="form-row__label">数据目录</div><div class="mono">{{ cfg.dataDir || '—' }}</div></div>
        <div class="form-row"><div class="form-row__label">工作目录</div><div class="mono">{{ cfg.workdir || '—' }}</div></div>
      </div>
    </template>
  `,
});
