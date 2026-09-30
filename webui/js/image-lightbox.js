// A1 前端 · 图片灯箱（全屏查看大图）——单例，供缩略图 / 聊天气泡复用
// 用法：import { openImageLightbox } from '../image-lightbox.js'; openImageLightbox(src)
let box = null;
let imgEl = null;

function ensureBox() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'img-lightbox';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', '图片查看');
  box.innerHTML =
    '<button type="button" class="img-lightbox__close" title="关闭（Esc）" aria-label="关闭">×</button>' +
    '<img class="img-lightbox__img" alt="查看图片">';
  imgEl = box.querySelector('.img-lightbox__img');

  // 点遮罩空白处关闭（点图片本身不关，避免误触）
  box.addEventListener('click', (e) => {
    if (e.target === box) close();
  });
  box.querySelector('.img-lightbox__close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && box && !box.hidden) { e.preventDefault(); close(); }
  });
  document.body.appendChild(box);
  return box;
}

function close() {
  if (!box) return;
  box.hidden = true;
  box.classList.remove('is-open');
  if (imgEl) imgEl.removeAttribute('src');
}

export function openImageLightbox(src) {
  if (!src) return;
  const b = ensureBox();
  imgEl.src = src;
  b.hidden = false;
  b.classList.add('is-open');
}
