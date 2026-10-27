/**
 * CodeMirror 5 行内图片预览：检测图片引用行 → addLineWidget 在行下方挂 <img>。
 *
 * 实现要点：
 * - 只识别「整行只有图片引用」的行（`![alt](src)`，可带前后空白），
 *   避免在段落中间插图打断排版
 * - onChange 增量维护：以行号 → widget 的 Map 对账，行删除/引用移除时清 widget
 * - 图片 src 解析与 app.js 的 rewritePreviewImages 同一套规则：
 *   相对/根路径 → api/asset 代理；外链/dataURL 原样
 *
 * 用法：attachInlineImages(mde, { repoPathOf })，返回 { refresh, destroy }
 */

const IMG_LINE_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

export function attachInlineImages(mde, { repoPathOf }) {
  const cm = mde.codemirror;
  /** lineHandle → { widget, src }（handle 被 CM 回收后作为 key 自动失效） */
  const widgets = new Map();

  function assetProxyUrl(repoPath) {
    return `api/asset?path=${encodeURIComponent(repoPath)}`;
  }

  function imgNode(repoPath) {
    const wrap = document.createElement("div");
    wrap.className = "cm-inline-image";
    const img = document.createElement("img");
    img.src = assetProxyUrl(repoPath);
    img.loading = "lazy";
    img.alt = "";
    img.addEventListener("error", () => {
      wrap.classList.add("img-broken");
    });
    wrap.appendChild(img);
    return wrap;
  }

  /** markdown src → 代理可用的仓库路径（外链原样返回） */
  function resolveSrc(src) {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    return repoPathOf(src);
  }

  function sweep() {
    // 1) 清失效 widget：handle 不在文档 / 行内容已不是图片引用 / src 变了
    for (const [handle, entry] of [...widgets]) {
      const lineNum = cm.getLineNumber(handle);
      const lineText = lineNum != null ? cm.getLine(lineNum) : null;
      const m = lineText ? lineText.match(IMG_LINE_RE) : null;
      const src = m ? resolveSrc(m[2].trim()) : null;
      if (lineNum == null || !m || src !== entry.src) {
        entry.widget.clear();
        widgets.delete(handle);
      }
    }
    // 2) 补挂新图片行
    for (let i = 0; i < cm.lineCount(); i++) {
      const line = cm.getLine(i);
      const m = line.match(IMG_LINE_RE);
      if (!m) continue;
      const handle = cm.getLineHandle(i);
      if (widgets.has(handle)) continue; // 已挂且 src 未变（上面校验过）
      const repoPath = resolveSrc(m[2].trim());
      if (!repoPath) continue;
      const node = imgNode(repoPath);
      const widget = cm.addLineWidget(handle, node, { coverGutter: false, noHScroll: true });
      widgets.set(handle, { widget, src: repoPath });
    }
  }

  let timer = null;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(sweep, 250); // debounce：打字过程中不频繁 sweep
  };
  cm.on("change", onChange);
  sweep();

  return {
    refresh: sweep,
    destroy() {
      clearTimeout(timer);
      cm.off("change", onChange);
      for (const [, entry] of widgets) entry.widget.clear();
      widgets.clear();
    },
  };
}
