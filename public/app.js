/**
 * shirone-admin 前端应用（vanilla ESM，零构建）。
 * 视图：登录 / 文章列表 / 动态列表 / 文章编辑器 / 动态编辑器。
 * DEV 模式下保存动作接收 .md / .zip 下载响应。
 */
import { mountDialogs } from "./dialogs.js";

// 对话框注册表（启动时挂载）
let DIALOGS = {};

const $app = document.getElementById("app");
const state = {
  devMode: false,
  view: "posts",
  tags: { post: [], moment: [] },
  current: { post: null, moment: null },
  editors: {},
  momentImages: [],
};

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...options,
    body: options.body instanceof FormData || typeof options.body === "string" ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("text/markdown") || contentType.includes("application/zip")) {
    return { download: res, filename: res.headers.get("X-Suggested-Filename") || "download.md" };
  }
  const json = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `请求失败（${res.status}）`);
  }
  return json.data;
}

function toast(msg, isErr = false) {
  const box = document.getElementById("toast-box");
  const el = document.createElement("div");
  el.className = `toast${isErr ? " err" : ""}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ---------- 登录 ----------

function renderLogin() {
  $app.innerHTML = "";
  $app.appendChild(document.getElementById("tpl-login").content.cloneNode(true));
  const form = document.getElementById("login-form");
  const errEl = document.getElementById("login-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    try {
      const data = await api("/login", { method: "POST", body: { password: form.password.value } });
      state.devMode = data.devMode;
      renderShell();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

// ---------- 主框架 ----------

function renderShell() {
  $app.innerHTML = "";
  const shell = document.getElementById("tpl-shell").content.cloneNode(true);
  $app.appendChild(shell);

  if (state.devMode) document.getElementById("dev-badge").hidden = false;
  document.getElementById("btn-logout").addEventListener("click", async () => {
    await api("/logout", { method: "POST" }).catch(() => {});
    renderLogin();
  });
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  }
  switchView("posts");
}

function switchView(view) {
  state.view = view;
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
  if (view === "posts") renderPostsList();
  else if (view === "moments") renderMomentsList();
}

// ---------- 文章列表 ----------

let postsCache = [];

async function renderPostsList() {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.appendChild(document.getElementById("tpl-posts").content.cloneNode(true));

  document.getElementById("btn-new-post").addEventListener("click", () => openPostEditor(null));
  document.getElementById("post-search").addEventListener("input", filterPosts);
  document.getElementById("post-hide-draft").addEventListener("change", filterPosts);

  const listEl = document.getElementById("post-list");
  listEl.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    postsCache = await api("/posts");
    drawPosts();
  } catch (err) {
    listEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function drawPosts() {
  const listEl = document.getElementById("post-list");
  const q = document.getElementById("post-search").value.trim().toLowerCase();
  const hideDraft = document.getElementById("post-hide-draft").checked;

  const items = postsCache.filter((p) => {
    if (hideDraft && p.draft) return false;
    if (!q) return true;
    return [p.title, p.category, ...(p.tags || [])].join(" ").toLowerCase().includes(q);
  });

  if (!items.length) {
    listEl.innerHTML = `<div class="empty">没有符合条件的文章</div>`;
    return;
  }
  listEl.innerHTML = "";
  for (const p of items) {
    const card = document.createElement("div");
    card.className = "content-card";
    card.innerHTML = `
      <div class="cc-main">
        <div class="cc-title">${esc(p.title)}
          ${p.draft ? '<span class="badge badge-draft">草稿</span>' : ""}
          ${p.pinned ? '<span class="badge badge-pinned">置顶</span>' : ""}
        </div>
        <div class="cc-sub">${esc([p.category, ...(p.tags || [])].filter(Boolean).map((t) => `#${t}`).join(" "))}</div>
      </div>
      <div class="cc-meta">${esc(p.published)}</div>`;
    card.addEventListener("click", () => openPostEditor(p.slug));
    listEl.appendChild(card);
  }
}

function filterPosts() {
  drawPosts();
}

// ---------- 动态列表 ----------

let momentsCache = [];

async function renderMomentsList() {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.appendChild(document.getElementById("tpl-moments").content.cloneNode(true));

  document.getElementById("btn-new-moment").addEventListener("click", () => openMomentEditor(null));
  document.getElementById("moment-search").addEventListener("input", drawMoments);
  document.getElementById("moment-hide-draft").addEventListener("change", drawMoments);

  const listEl = document.getElementById("moment-list");
  listEl.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    momentsCache = await api("/moments");
    drawMoments();
  } catch (err) {
    listEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function drawMoments() {
  const listEl = document.getElementById("moment-list");
  const q = document.getElementById("moment-search").value.trim().toLowerCase();
  const hideDraft = document.getElementById("moment-hide-draft").checked;

  const items = momentsCache.filter((m) => {
    if (hideDraft && m.draft) return false;
    if (!q) return true;
    return [m.excerpt, ...(m.tags || [])].join(" ").toLowerCase().includes(q);
  });

  if (!items.length) {
    listEl.innerHTML = `<div class="empty">没有符合条件的动态</div>`;
    return;
  }
  listEl.innerHTML = "";
  for (const m of items) {
    const card = document.createElement("div");
    card.className = "content-card";
    card.innerHTML = `
      <div class="cc-main">
        <div class="cc-title">${esc(m.excerpt || "(无文字)")}
          ${m.draft ? '<span class="badge badge-draft">草稿</span>' : ""}
          ${m.pinned ? '<span class="badge badge-pinned">置顶</span>' : ""}
          ${m.imageCount ? `<span class="badge">🖼 ${m.imageCount}</span>` : ""}
        </div>
        <div class="cc-sub">${esc([m.location, ...(m.tags || []).map((t) => `#${t}`)].filter(Boolean).join(" "))}</div>
      </div>
      <div class="cc-meta">${esc(m.published)}</div>`;
    card.addEventListener("click", () => openMomentEditor(m.id));
    listEl.appendChild(card);
  }
}

// ---------- 文章编辑器 ----------

async function openPostEditor(slug) {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.appendChild(document.getElementById("tpl-post-editor").content.cloneNode(true));

  const isNew = !slug;
  let post = isNew
    ? { slug: "", path: "", sha: null, frontmatter: {}, body: "", images: [], referencedImages: [] }
    : await api(`/posts/${encodeURIComponent(slug)}`);
  state.current.post = post;

  // 表单回填
  const fm = post.frontmatter || {};
  qs("#pe-title").value = fm.title || "";
  qs("#pe-slug").value = post.slug || "";
  qs("#pe-slug").readOnly = !isNew;
  if (!isNew) qs("#pe-slug").title = "编辑模式下 slug 不可修改（避免破坏已发布链接）";
  qs("#pe-category").value = fm.category || "";
  qs("#pe-image").value = fm.image || "";
  qs("#pe-description").value = fm.description || "";
  qs("#pe-pinned").checked = fm.pinned === true;
  qs("#pe-draft").checked = fm.draft === true;
  qs("#pe-comment").checked = fm.comment !== false;
  qs("#pe-refresh-updated").closest("label").hidden = isNew;
  state.tags.post = Array.isArray(fm.tags) ? [...fm.tags] : [];
  drawTags("post");

  // 元信息提示（保护未知字段，如加密文章）
  const unknownKeys = Object.keys(fm).filter(
    (k) => !["title", "published", "publishedAt", "updated", "updatedAt", "description", "image", "category", "tags", "pinned", "draft", "comment"].includes(k),
  );
  const note = qs("#pe-meta-note");
  if (unknownKeys.length) {
    note.hidden = false;
    note.textContent = `检测到保留字段：${unknownKeys.join("、")}（保存时原样保留，不会被覆盖）`;
  }

  const initial = post.body || "";
  const mde = new EasyMDE({
    element: qs("#pe-md"),
    initialValue: initial,
    spellChecker: false,
    toolbar: [
      "bold", "italic", "heading", "|", "quote", "unordered-list", "ordered-list", "|",
      "link", "image", "table", "code", "|",
      {
        name: "admonition",
        action: (editor) => DIALOGS.admonition(editor),
        title: "提示容器",
        className: "fa fa-star",
      },
      {
        name: "field-card",
        action: (editor) => DIALOGS.fieldGroup(editor),
        title: "字段参数卡片",
        className: "fa fa-id-card",
      },
      {
        name: "collapse-panel",
        action: (editor) => DIALOGS.collapsePanel(editor),
        title: "折叠面板",
        className: "fa fa-caret-square-o-down",
      },
      {
        name: "tabs",
        action: (editor) => DIALOGS.tabs(editor),
        title: "代码标签页",
        className: "fa fa-folder-open",
      },
      {
        name: "code-tree",
        action: (editor) => DIALOGS.codeTree(editor),
        title: "交互代码树",
        className: "fa fa-tree",
      },
      {
        name: "steps",
        action: (editor) => DIALOGS.steps(editor),
        title: "步骤条",
        className: "fa fa-list-ol",
      },
      {
        name: "video",
        action: (editor) => DIALOGS.video(editor),
        title: "视频嵌入",
        className: "fa fa-youtube-play",
      },
      {
        name: "github-card",
        action: (editor) => DIALOGS.githubCard(editor),
        title: "GitHub 仓库卡片",
        className: "fa fa-github",
      },
      {
        name: "image-grid",
        action: (editor) => DIALOGS.imageGrid(editor, { images: post.images }),
        title: "图片画廊",
        className: "fa fa-th-large",
      },
      {
        name: "highlight",
        action: wrapInline("==", "=="),
        title: "荧光高亮",
        className: "fa fa-highlighter",
      },
      {
        name: "spoiler",
        action: wrapInline(":spoiler[", "]"),
        title: "剧透黑幕",
        className: "fa fa-eye-slash",
      },
      {
        name: "katex-inline",
        action: wrapInline("$", "$"),
        title: "行内公式",
        className: "fa fa-superscript",
      },
      {
        name: "mermaid",
        action: insertBlock("```mermaid\nflowchart LR\n    A[开始] --> B[结束]\n```"),
        title: "Mermaid 图表",
        className: "fa fa-project-diagram",
      },
      {
        name: "math-block",
        action: insertBlock("$$\n\\\\int_{-\\\\infty}^{+\\\\infty} e^{-x^2} dx = \\\\sqrt{\\\\pi}\n$$"),
        title: "块级公式",
        className: "fa fa-calculator",
      },
      "|", "preview", "side-by-side", "fullscreen", "guide",
    ],
  });
  state.editors.post = mde;

  // 从标题自动生成 slug 建议（仅当用户尚未手动编辑过 slug）
  let slugTouched = isNew ? qs("#pe-slug").value.trim().length > 0 : true;
  qs("#pe-slug").addEventListener("input", () => { slugTouched = true; });
  qs("#pe-title").addEventListener("input", () => {
    if (isNew && !slugTouched) {
      qs("#pe-slug").value = suggestSlug(qs("#pe-title").value);
    }
  });

  // 上传
  qs("#btn-upload-image").addEventListener("click", () => qs("#pe-file").click());
  qs("#pe-file").addEventListener("change", (e) => handleUploadFiles(e.target.files, "post"));
  setupEditorDrop(mde, "post");
  setupEditorPaste(mde, "post");

  // 保存
  qs("#btn-save-post").addEventListener("click", () => savePost(isNew));
  qs("#btn-back").addEventListener("click", () => renderPostsList());
  qs("#btn-delete-post").addEventListener("click", () => deleteContent("post", post.slug));

  drawUploadList();
}

function collectPostForm() {
  return {
    slug: qs("#pe-slug").value.trim(),
    title: qs("#pe-title").value.trim(),
    category: qs("#pe-category").value.trim(),
    image: qs("#pe-image").value.trim(),
    description: qs("#pe-description").value.trim(),
    tags: state.tags.post,
    pinned: qs("#pe-pinned").checked,
    draft: qs("#pe-draft").checked,
    comment: qs("#pe-comment").checked,
    refreshUpdated: qs("#pe-refresh-updated").checked,
  };
}

async function savePost(isNew) {
  const form = collectPostForm();
  const body = state.editors.post.value();
  const payload = { form, body };
  const btn = qs("#btn-save-post");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const res = await api(isNew ? "/posts" : `/posts/${encodeURIComponent(state.current.post.slug)}`, {
      method: isNew ? "POST" : "PUT",
      body: payload,
    });
    if (res.download) {
      triggerDownload(res.download, res.filename);
      toast(`DEV 模式：已生成下载（${res.filename}）`);
    } else {
      toast(`${res.message}${res.commitUrl ? "，已推送 GitHub" : ""}`);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

// ---------- 动态编辑器 ----------

const MOODS = [
  { icon: "material-symbols:sentiment-satisfied-outline-rounded", emoji: "😊", label: "开心" },
  { icon: "material-symbols:sentiment-excited-outline-rounded", emoji: "🤩", label: "兴奋" },
  { icon: "material-symbols:sentiment-neutral-outline-rounded", emoji: "😐", label: "专注" },
  { icon: "material-symbols:sentiment-sad-outline-rounded", emoji: "😪", label: "疲惫" },
  { icon: "material-symbols:lightbulb-outline-rounded", emoji: "💡", label: "灵感" },
];

async function openMomentEditor(id) {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.appendChild(document.getElementById("tpl-moment-editor").content.cloneNode(true));

  const isNew = !id;
  let moment = isNew
    ? { id: "", sha: null, frontmatter: {}, body: "" }
    : await api(`/moments/${encodeURIComponent(id)}`);
  state.current.moment = moment;
  state.momentImages = Array.isArray(moment.frontmatter?.images) ? moment.frontmatter.images.map((i) => ({ ...i })) : [];

  const fm = moment.frontmatter || {};
  qs("#me-location").value = fm.location || "";
  qs("#me-pinned").checked = fm.pinned === true;
  qs("#me-draft").checked = fm.draft === true;
  state.tags.moment = Array.isArray(fm.tags) ? [...fm.tags] : [];
  drawTags("moment");

  // 心情选择
  const moodRow = qs("#me-moods");
  moodRow.innerHTML = "";
  for (const m of MOODS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mood-btn";
    btn.title = m.label;
    btn.textContent = m.emoji;
    btn.dataset.icon = m.icon;
    if (fm.mood === m.icon) btn.classList.add("active");
    btn.addEventListener("click", () => {
      const active = btn.classList.contains("active");
      moodRow.querySelectorAll(".mood-btn").forEach((b) => b.classList.remove("active"));
      if (!active) btn.classList.add("active");
    });
    moodRow.appendChild(btn);
  }

  // 正文编辑器（轻量，直接 textarea）
  qs("#me-md").value = moment.body || "";

  drawMomentImages();

  qs("#btn-upload-moment-image").addEventListener("click", () => qs("#me-file").click());
  qs("#me-file").addEventListener("change", (e) => handleUploadFiles(e.target.files, "moment"));

  qs("#btn-save-moment").addEventListener("click", () => saveMoment(isNew));
  qs("#btn-back").addEventListener("click", () => renderMomentsList());
  qs("#btn-delete-moment").addEventListener("click", () => deleteContent("moment", moment.id));
  qs("#btn-locate").addEventListener("click", locateMe);
}

/** 定位：浏览器 GPS 优先（精确），拒绝/失败自动降级 IP 定位 */
async function locateMe() {
  const btn = qs("#btn-locate");
  const hint = qs("#locate-hint");
  btn.disabled = true;
  btn.textContent = "定位中…";

  const fill = (data) => {
    qs("#me-location").value = data.place;
    hint.textContent = `已定位：${data.place}（${data.source === "ip" ? "IP 定位" : "浏览器定位"}）`;
  };
  const finish = () => {
    btn.disabled = false;
    btn.textContent = "📍 定位";
  };

  // 无 Geolocation 支持或非安全上下文 → 直接 IP 定位
  if (!navigator.geolocation || !window.isSecureContext) {
    try {
      fill(await api("/geocode"));
    } catch (err) {
      hint.textContent = err.message;
    }
    finish();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        fill(await api(`/geocode?lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`));
      } catch (err) {
        // 逆地理失败 → IP 兜底
        try {
          fill(await api("/geocode"));
        } catch (err2) {
          hint.textContent = err2.message;
        }
      }
      finish();
    },
    async (err) => {
      // GPS 拒绝/失败 → IP 兜底
      try {
        fill(await api("/geocode"));
      } catch (err2) {
        hint.textContent =
          err.code === err.PERMISSION_DENIED
            ? `定位权限被拒绝；${err2.message}`
            : err2.message;
      }
      finish();
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
  );
}

function selectedMood() {
  const active = document.querySelector("#me-moods .mood-btn.active");
  return active ? active.dataset.icon : "";
}

function drawMomentImages() {
  const grid = qs("#me-image-grid");
  grid.innerHTML = "";
  state.momentImages.forEach((img, idx) => {
    const cell = document.createElement("div");
    cell.className = "mi-cell";
    cell.innerHTML = `<img src="${esc(img.src)}" alt="${esc(img.alt || "")}" loading="lazy" />
      <button type="button" class="mi-remove" title="移除">×</button>`;
    cell.querySelector(".mi-remove").addEventListener("click", () => {
      state.momentImages.splice(idx, 1);
      drawMomentImages();
    });
    grid.appendChild(cell);
  });
}

async function saveMoment(isNew) {
  const form = {
    location: qs("#me-location").value.trim(),
    mood: selectedMood(),
    tags: state.tags.moment,
    pinned: qs("#me-pinned").checked,
    draft: qs("#me-draft").checked,
    images: state.momentImages,
    suffix: suggestSuffix(qs("#me-location").value || state.tags.moment[0] || ""),
  };
  const body = qs("#me-md").value;
  const btn = qs("#btn-save-moment");
  btn.disabled = true;
  btn.textContent = "发布中…";
  try {
    const res = await api(isNew ? "/moments" : `/moments/${encodeURIComponent(state.current.moment.id)}`, {
      method: isNew ? "POST" : "PUT",
      body: { form, body },
    });
    if (res.download) {
      triggerDownload(res.download, res.filename);
      toast(`DEV 模式：已生成下载（${res.filename}）`);
    } else {
      toast(`${res.message}${res.commitUrl ? "，已推送 GitHub" : ""}`);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "发布";
  }
}

// ---------- 图片上传（编辑器拖拽 / 按钮） ----------

function momentDateForUpload() {
  // 动态图片目录日期：新建用今天，编辑用原 published 前 10 位
  const current = state.current.moment?.frontmatter?.published;
  if (typeof current === "string" && /^\d{4}-\d{2}-\d{2}/.test(current)) return current.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function handleUploadFiles(fileList, target) {
  for (const file of fileList) {
    uploadOne(file, target);
  }
}

async function uploadOne(file, target) {
  const listEl = target === "post" ? qs("#pe-upload-list") : qs("#me-upload-list");
  const item = document.createElement("span");
  item.className = "upload-item";
  item.textContent = `↑ ${file.name} 上传中…`;
  listEl.appendChild(item);

  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("target", target);
    if (target === "post") fd.append("slug", qs("#pe-slug").value.trim());
    else fd.append("momentDate", momentDateForUpload());

    const data = await api("/upload", { method: "POST", body: fd });
    item.textContent = `✓ ${file.name}`;
    item.classList.add("ok");

    if (target === "post") {
      // 记录到已传图清单 + 在光标处插入引用
      state.current.post.images.push({ repoPath: data.repoPath, webPath: data.webPath, name: data.filename });
      insertAtCursor(state.editors.post, `\n${data.markdownRef}\n`);
      drawUploadList();
    } else {
      state.momentImages.push({ src: data.webPath, alt: data.filename });
      drawMomentImages();
    }
  } catch (err) {
    item.textContent = `✗ ${file.name}: ${err.message}`;
    item.classList.add("fail");
  }
}

function drawUploadList() {
  // 文章已传图清单即 upload-list（上传时逐条添加，此处仅刷新 image-grid 对话框数据源）
}

function setupEditorDrop(mde, target) {
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

function setupEditorPaste(mde, target) {
  mde.codemirror.on("paste", (cm, e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      for (const f of files) uploadOne(f, target);
    }
  });
}

// ---------- 删除 ----------

async function deleteContent(kind, id) {
  if (!confirm(`确定删除？此操作${state.devMode ? "在 DEV 模式下无副作用" : "会提交删除到 GitHub 仓库"}`)) return;
  try {
    const res = await api(`/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(res.message || "已删除");
    if (kind === "post") renderPostsList();
    else renderMomentsList();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- 工具 ----------

function qs(sel) {
  return document.querySelector(sel);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function drawTags(kind) {
  const box = qs(kind === "post" ? "#pe-tag-box" : "#me-tag-box");
  const input = qs(kind === "post" ? "#pe-tags" : "#me-tags");
  box.innerHTML = "";
  for (const tag of state.tags[kind]) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `#${esc(tag)} <button type="button" title="移除">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      state.tags[kind] = state.tags[kind].filter((t) => t !== tag);
      drawTags(kind);
    });
    box.appendChild(chip);
  }
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = input.value.trim().replace(/^#/, "");
      if (val && !state.tags[kind].includes(val)) {
        state.tags[kind].push(val);
        drawTags(kind);
      }
      input.value = "";
    }
  };
}

function insertAtCursor(mde, text) {
  const cm = mde.codemirror;
  const pos = cm.getCursor();
  cm.replaceRange(text, pos);
  cm.focus();
}

function wrapInline(before, after) {
  return (editor) => {
    const cm = editor.codemirror;
    const selected = cm.getSelection();
    cm.replaceSelection(`${before}${selected || "文本"}${after}`);
    cm.focus();
  };
}

function insertBlock(text) {
  return (editor) => {
    const cm = editor.codemirror;
    const cursor = cm.getCursor();
    cm.replaceSelection(`\n${text}\n`);
    cm.setCursor({ line: cursor.line + 1, ch: 0 });
    cm.focus();
  };
}

/** 中文标题 → slug 建议（非 ASCII 字符折叠为连字符） */
function suggestSlug(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "post";
}

function suggestSuffix(text) {
  return suggestSlug(text);
}

/** 触发浏览器下载 */
async function triggerDownload(res, filename) {
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

// ---------- 启动 ----------

DIALOGS = mountDialogs({ toast });
api("/me")
  .then((data) => {
    state.devMode = data.devMode;
    renderShell();
  })
  .catch(() => renderLogin());
