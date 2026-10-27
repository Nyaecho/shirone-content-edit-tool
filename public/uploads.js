/**
 * 图片上传链路：编辑器拖拽/粘贴/按钮上传 + 文章已传图清单 + 封面图覆盖式上传。
 */
import { qs, assetUrl, esc } from "./utils.js";
import { api, toast } from "./api-client.js";
import { state } from "./state.js";
import { insertAtCursor } from "./utils.js";

function momentDateForUpload() {
  // 动态图片目录日期：新建用今天，编辑用原 published 前 10 位
  const current = state.current.moment?.frontmatter?.published;
  if (typeof current === "string" && /^\d{4}-\d{2}-\d{2}/.test(current)) return current.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export function handleUploadFiles(fileList, target) {
  for (const file of fileList) {
    uploadOne(file, target);
  }
}

/** 上传单张正文图：进服务器暂存区，成功后插入光标处 + 已传图清单 */
export async function uploadOne(file, target) {
  const listEl = target === "post" ? qs("#pe-upload-list") : qs("#me-upload-list");
  const item = document.createElement("span");
  item.className = "upload-item";
  item.textContent = `上传中 ${file.name}…`;
  listEl.appendChild(item);

  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("target", target);
    if (target === "post") fd.append("slug", qs("#pe-slug").value.trim());
    else fd.append("momentDate", momentDateForUpload());

    const data = await api("/upload", { method: "POST", body: fd });
    item.remove();

    if (target === "post") {
      state.current.post.images.push({ repoPath: data.repoPath, webPath: data.webPath, name: data.filename });
      insertAtCursor(state.editors.post, `\n${data.markdownRef}\n`);
      drawUploadList();
    } else {
      state.momentImages.push({ src: data.webPath, alt: data.filename });
      drawMomentImages();
    }
  } catch (err) {
    item.textContent = `失败 ${file.name}: ${err.message}`;
    item.classList.add("fail");
  }
}

/** 动态九宫格渲染（me-image-grid） */
export function drawMomentImages() {
  const grid = qs("#me-image-grid");
  if (!grid) return;
  grid.innerHTML = "";
  state.momentImages.forEach((img, idx) => {
    const cell = document.createElement("div");
    cell.className = "mi-cell";
    // src 为站点根路径（/images/albums/...）→ 转仓库路径走代理预览
    const repoPath = String(img.src || "").startsWith("/")
      ? `public${String(img.src).split("?")[0]}`
      : String(img.src || "");
    cell.innerHTML = `<img src="${assetUrl(repoPath)}" alt="${esc(img.alt || "")}" loading="lazy" />
      <button type="button" class="mi-remove" title="移除">×</button>`;
    cell.querySelector(".mi-remove").addEventListener("click", () => {
      state.momentImages.splice(idx, 1);
      drawMomentImages();
    });
    grid.appendChild(cell);
  });
}

/**
 * 文章已传图清单：缩略图 + 文件名 + 插入引用/移除。
 */
export function drawUploadList() {
  const listEl = qs("#pe-upload-list");
  if (!listEl) return;
  const images = state.current.post?.images || [];
  listEl.innerHTML = "";
  if (!images.length) return;
  for (const img of images) {
    const cell = document.createElement("div");
    cell.className = "uploaded-image";
    cell.innerHTML = `
      <img src="${assetUrl(img.repoPath)}" alt="${esc(img.name || "")}" loading="lazy" />
      <div class="ui-actions">
        <button type="button" class="ui-btn" data-act="insert" title="在光标处插入引用">插入</button>
        <button type="button" class="ui-btn ui-btn-danger" data-act="remove" title="从清单移除（不删除仓库文件）">移除</button>
      </div>
      <span class="ui-name" title="${esc(img.repoPath)}">${esc(img.name || "")}</span>`;
    cell.querySelector('[data-act="insert"]').addEventListener("click", () => {
      insertAtCursor(state.editors.post, `\n![${img.name}](./${img.name})\n`);
    });
    cell.querySelector('[data-act="remove"]').addEventListener("click", () => {
      const cur = state.current.post;
      cur.images = cur.images.filter((i) => i.repoPath !== img.repoPath);
      drawUploadList();
    });
    listEl.appendChild(cell);
  }
}

export function setupEditorDrop(mde, target) {
  const wrapper = mde.codemirror.getWrapperElement();
  wrapper.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      e.stopPropagation();
      for (const f of files) uploadOne(f, target);
    }
  });
}

export function setupEditorPaste(mde, target) {
  mde.codemirror.on("paste", (cm, e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      for (const f of files) uploadOne(f, target);
    }
  });
}

// ---------- 封面图上传（固定 cover.<ext>，覆盖式） ----------

/** 封面引用 → 可预览 URL（相对 ./cover.xx 走 asset 代理；外链原样；无封面 null） */
function coverPreviewUrl(ref, slug) {
  if (!ref) return null;
  if (/^(https?:|data:|blob:)/i.test(ref)) return ref;
  const name = ref.startsWith("./") ? ref.slice(2) : ref;
  return assetUrl(`content/posts/${slug}/${name}`);
}

/**
 * 渲染封面组件状态：无封面 = 「点击上传」；有封面 = 缩略图 + 「重新上传」。
 */
export function renderCoverState(ref, slug) {
  const btn = qs("#btn-upload-cover");
  const thumb = qs("#pe-cover-thumb");
  const hint = qs("#pe-cover-hint");
  if (!btn || !thumb) return;
  const url = coverPreviewUrl(ref, slug);
  if (url) {
    thumb.src = url;
    thumb.hidden = false;
    btn.textContent = "重新上传";
    if (hint) hint.textContent = "再次上传将覆盖当前封面";
  } else {
    thumb.hidden = true;
    thumb.removeAttribute("src");
    btn.textContent = "点击上传";
    if (hint) hint.textContent = "固定 cover 文件名，重复上传覆盖";
  }
}

/** 绑定封面上传交互：选文件 → POST /upload(target=cover) → 缩略图 + 联动自动保存 */
export function setupCoverUpload({ getSlug, onSaved }) {
  const btn = qs("#btn-upload-cover");
  const fileInput = qs("#pe-cover-file");
  if (!btn || !fileInput) return;

  btn.addEventListener("click", () => {
    const slug = getSlug();
    if (!slug) {
      toast("请先填写 Slug 再上传封面（图片存文章目录）", true);
      return;
    }
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // 允许连续选同一文件重传
    if (!file) return;
    const slug = getSlug();
    if (!slug) {
      toast("请先填写 Slug 再上传封面", true);
      return;
    }
    btn.disabled = true;
    btn.textContent = "上传中…";
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("target", "cover");
      fd.append("slug", slug);
      const data = await api("/upload", { method: "POST", body: fd });
      const name = data.repoPath.split("/").pop();
      const ref = `./${name}`;
      renderCoverState(ref, slug);
      onSaved?.(ref);
      toast("封面已上传（保存时随文章推送）");
    } catch (err) {
      toast(`封面上传失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
      renderCoverState(qs("#pe-image").value || "", slug);
    }
  });
}
