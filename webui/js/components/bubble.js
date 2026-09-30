// A1 前端 · 消息气泡（T-C4）——对齐美工契约类名 .bubble/.bubble-ai/.bubble-user/.bubble__meta
import { defineComponent, computed } from 'vue';
import { renderMarkdown } from '../markdown.js';
import { openImageLightbox } from '../image-lightbox.js';

export function textOf(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.type === 'text' ? p.text : (p && p.type === 'image_url' ? '[图片]' : ''))).join('');
  return String(c == null ? '' : c);
}

// v6.23：只取文本段（数组 content 中 type==='text'）——用户气泡用它，
// 避免 image_url 被 textOf 渲染成 [图片] 文本、与 img 元素重复
export function textOnly(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
  return String(c == null ? '' : c);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

export const Bubble = defineComponent({
  name: 'Bubble',
  props: { msg: { type: Object, required: true } },
  setup(props) {
    const isUser = computed(() => (props.msg.role || 'assistant') === 'user');
    const isDivider = computed(() => !!props.msg._divider);
    const isCompaction = computed(() => !!props.msg._compaction);
    const streaming = computed(() => !!props.msg._streaming);
    const isEngine = computed(() => !!props.msg.engine);   // 引擎/系统消息（伪 user）→ 系统样式，勿冒充用户
    const html = computed(() => (isUser.value ? '' : renderMarkdown(textOf(props.msg))));
    const userHtml = computed(() => (isUser.value ? esc(textOnly(props.msg)) : ''));
    const meta = computed(() => (isEngine.value ? '系统' : (isUser.value ? '主人' : '雷仔 · 主我')));   // v6.45：去掉 emoji 闪电符号，改由模板插 logo 图形
    // v6.23：从 content 数组提取图片（image_url）——文本走文本、图片走 img 元素
    const images = computed(() => {
      const c = props.msg && props.msg.content;
      if (!Array.isArray(c)) return [];
      return c.filter((p) => p && p.type === 'image_url' && p.image_url && p.image_url.url)
        .map((p) => p.image_url.url);
    });
    function open(u) { openImageLightbox(u); }
    return { isUser, isDivider, isCompaction, streaming, html, userHtml, meta, images, open, isEngine };
  },
  template: `
    <div v-if="isDivider" class="gen-divider" :data-gen="msg._gen || ''"><img class="gen-divider__logo" src="./assets/logo.svg" alt="" aria-hidden="true">{{ msg.content }}</div>
    <div v-else :class="['bubble', (isUser && !isEngine) ? 'bubble-user' : 'bubble-ai', { 'bubble--streaming': streaming, 'bubble--engine': isEngine }]"
         :data-role="isEngine ? 'engine' : (isUser ? 'user' : 'main')">
      <div class="bubble__meta"><img v-if="!isUser && !isEngine" class="bubble__logo" src="./assets/logo.svg" alt="" aria-hidden="true">{{ meta }}<span v-if="isCompaction" class="chip chip--acc" style="margin-left:6px;">交接文档</span><span v-if="isEngine" class="chip" style="margin-left:6px;">引擎</span></div>
      <div v-if="isUser && userHtml" class="md" v-html="userHtml"></div>
      <div v-if="images.length" class="bubble__imgs">
        <img v-for="(u, i) in images" :key="i" class="bubble__img" :src="u" alt="图片" draggable="false" @click="open(u)">
      </div>
      <div v-if="!isUser" class="md" v-html="html"></div>
    </div>
  `,
});
