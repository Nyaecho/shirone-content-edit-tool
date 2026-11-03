/**
 * 共享工具：DOM 查询、转义、slug 建议、资源 URL、下载触发。
 * 被所有前端模块引用的基础层，不含业务逻辑。
 */

export function qs(sel) {
  return document.querySelector(sel);
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 仓库路径/web 路径 → 可预览的 URL（admin 下的图片代理，带 Cookie 认证）。
 *  相对路径叠加当前浏览器 URL，反向代理挂在子路径（如 /blog-admin/）时同样成立。 */
export function assetUrl(repoPath) {
  return `api/asset?path=${encodeURIComponent(repoPath)}`;
}

/** 文章图片 src → 仓库路径：相对路径（./x 或不以 / 开头）按文章资产目录
 *  content/posts/<slug>/x 解析；/content/...、/public/...（uploads.js webPath 形态，
 *  画廊插入引用即此形态）剥前导斜杠映射回仓库路径；其余站点根绝对路径（/images/...）
 *  映射 public/ 前缀并剥掉 query 串。预览改写与行内图片预览共用同一套规则。 */
export function postSrcToRepoPath(src, slug) {
  if (src.startsWith("/content/") || src.startsWith("/public/")) {
    return src.split("?")[0].slice(1);
  }
  if (src.startsWith("./") || !src.startsWith("/")) {
    return `content/posts/${slug}/${src.replace(/^\.?\//, "")}`;
  }
  return `public${src.split("?")[0]}`;
}

/** 图片 src → 仓库路径（动态/画廊口径）：站点根绝对路径（/...）映射 public/ 前缀
 *  并剥 query 串；相对路径原样返回（动态无文章资产目录概念）。 */
export function siteSrcToRepoPath(src) {
  const s = String(src || "");
  return s.startsWith("/") ? `public${s.split("?")[0]}` : s;
}

/** 中文标题 → slug 建议（非 ASCII 字符折叠为连字符）。
 *  归一为空时返回 ""（用户需求：slug 可留空，发布时服务端自动生成），不再兜底 "post"。 */
export function suggestSlug(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** 时间戳 slug `MMDD-HHmm`（如 1103-1945）：与服务端 createPost 自动生成同构
 *  （Intl en-CA + formatToParts；服务端用站点时区，此处缺省浏览器本地时区）。
 *  上传图片自动回填用（用户需求：slug 可留空）。 */
export function autoSlug(timeZone) {
  const opts = {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  };
  if (timeZone) opts.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", opts).formatToParts(new Date());
  const v = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${v.month}${v.day}-${v.hour}${v.minute}`;
}

export function suggestSuffix(text) {
  // 空兜底改用 HHmm（动态文件名如 2026-11-03-1945.md），不再复用已删除的 "post"
  return suggestSlug(text) || autoSlug().slice(5);
}

/** 触发浏览器下载 */
export async function triggerDownload(res, filename) {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 在 CodeMirror 光标处插入文本 */
export function insertAtCursor(mde, text) {
  const cm = mde.codemirror;
  const pos = cm.getCursor();
  cm.replaceRange(text, pos);
  cm.focus();
}

/** 包裹选区为行内语法（无选区时用占位文本） */
export function wrapInline(before, after) {
  return (editor) => {
    const cm = editor.codemirror;
    const selected = cm.getSelection();
    cm.replaceSelection(`${before}${selected || "文本"}${after}`);
    cm.focus();
  };
}

/** 插入块级语法（前后空行，光标落块内首行） */
export function insertBlock(text) {
  return (editor) => {
    const cm = editor.codemirror;
    const cursor = cm.getCursor();
    cm.replaceSelection(`\n${text}\n`);
    cm.setCursor({ line: cursor.line + 1, ch: 0 });
    cm.focus();
  };
}
