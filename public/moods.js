/**
 * 心情表情图标（内联 SVG，24×24 视窗，stroke 线性风格）。
 * UI 显示用；写进 frontmatter 的仍是 iconify 名（站点渲染口径不变）。
 * 新增心情：在此追加 { icon, label, svg } 即可，UI 自动渲染。
 */
export const MOODS = [
  {
    icon: "material-symbols:sentiment-excited-outline-rounded",
    label: "兴奋",
    svg: `<circle cx="12" cy="12" r="9"/><path d="M8 14c.8 1.6 2.2 2.4 4 2.4s3.2-.8 4-2.4"/><path d="M8.5 10.5h.01M15.5 10.5h.01" stroke-width="2.6" stroke-linecap="round"/><path d="M7 8.5l2-1M17 8.5l-2-1" stroke-linecap="round"/>`,
  },
  {
    icon: "material-symbols:sentiment-satisfied-outline-rounded",
    label: "开心",
    svg: `<circle cx="12" cy="12" r="9"/><path d="M8 14c.8 1.6 2.2 2.4 4 2.4s3.2-.8 4-2.4"/><circle cx="9" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r=".9" fill="currentColor" stroke="none"/>`,
  },
  {
    icon: "material-symbols:sentiment-neutral-outline-rounded",
    label: "平静",
    svg: `<circle cx="12" cy="12" r="9"/><path d="M8.5 15h7"/><circle cx="9" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r=".9" fill="currentColor" stroke="none"/>`,
  },
  {
    icon: "material-symbols:sentiment-dissatisfied-outline-rounded",
    label: "沮丧",
    svg: `<circle cx="12" cy="12" r="9"/><path d="M8 16c.8-1.6 2.2-2.4 4-2.4s3.2 .8 4 2.4"/><circle cx="9" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r=".9" fill="currentColor" stroke="none"/>`,
  },
  {
    icon: "material-symbols:sentiment-frustrated-outline-rounded",
    label: "烦躁",
    svg: `<circle cx="12" cy="12" r="9"/><path d="M8 16.5c.5-1.8 2.1-2.9 4-2.9s3.5 1.1 4 2.9"/><path d="M7.5 9.5l2 1M16.5 9.5l-2 1" stroke-linecap="round"/><path d="M9 10.5h.01M15 10.5h.01" stroke-width="2.6" stroke-linecap="round"/>`,
  },
  {
    icon: "material-symbols:sentiment-extremely-dissatisfied-outline-rounded",
    label: "愤怒",
    svg: `<circle cx="12" cy="12" r="9"/><path d="M8 17c.6-2 2.1-3 4-3s3.4 1 4 3"/><path d="M7 8l3 1.6M17 8l-3 1.6" stroke-linecap="round"/><path d="M8.6 11.5l1.4 1M15.4 11.5l-1.4 1" stroke-width="2.2" stroke-linecap="round"/>`,
  },
];

/** 渲染单个心情 SVG（包裹 <svg> 壳，返回节点） */
export function moodSvg(mood, size = 20) {
  const span = document.createElement("span");
  span.className = "mood-svg";
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${mood.svg}</svg>`;
  return span;
}
