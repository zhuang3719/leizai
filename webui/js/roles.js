// A1 前端 · 角色元数据（颜色/字形/图标）——对齐 themes.css 的角色 token
// v6.48：雷影统一显示全名「雷影·X」（气泡/通知/通讯中心一致）；主我保持「主我」。
//   short = 紧凑场景专用短名（如 Nexus 环流轨道标签，避免长名溢出/互相压字）。
export const ROLE_META = {
  main:         { name: '主我',        short: '主我',   glyph: '⚡', cls: 'role-main',        icon: '/assets/role-main.svg' },
  programmer:  { name: '雷影·程序员', short: '程序员', glyph: '程', cls: 'role-programmer',  icon: '/assets/role-programmer.svg' },
  designer:      { name: '雷影·美工',   short: '美工',   glyph: '美', cls: 'role-artist',      icon: '/assets/role-artist.svg' },
  writer:        { name: '雷影·文案',   short: '文案',   glyph: '文', cls: 'role-writer',      icon: '/assets/role-writer.svg' },
  tester:        { name: '雷影·测试员', short: '测试员', glyph: '测', cls: 'role-tester',      icon: '/assets/role-tester.svg' },
  researcher:       { name: '雷影·研究员', short: '研究员', glyph: '研', cls: 'role-researcher', icon: '/assets/role-researcher.svg' },
  sales:           { name: '雷影·销售',   short: '销售',   glyph: '销', cls: 'role-sales',      icon: '/assets/role-sales.svg' },
};

export function roleMeta(role) {
  return ROLE_META[role] || { name: role || '未知', short: role || '未知', glyph: (role || '?').slice(0, 1), cls: 'role-main', icon: '/assets/role-main.svg' };
}

// 会话头像角色：不再按标题猜角色（曾误判"开源项目研究"→研究员）。
// 普通会话一律「主我」；真有雷影参与时由 sessions.js 的 group(s) 组合头像承担，与本函数无关。
export function guessSessionRole(_s) {
  return 'main';
}

export function relTime(ts) {
  if (!ts) return '';
  const d = (typeof ts === 'number' ? ts : Date.parse(ts));
  if (!d || isNaN(d)) return '';
  const diff = Date.now() - d;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  const dt = new Date(d);
  return (dt.getMonth() + 1) + '/' + dt.getDate();
}

export function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
