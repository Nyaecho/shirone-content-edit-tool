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

/** 中文标题 → slug 建议（非 ASCII 字符折叠为连字符） */
export function suggestSlug(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "post";
}

export function suggestSuffix(text) {
  return suggestSlug(text);
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
