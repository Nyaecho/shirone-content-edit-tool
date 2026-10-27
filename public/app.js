/**
 * shirone-admin 前端应用（vanilla ESM，零构建）。
 * 视图：登录 / 文章列表 / 动态列表 / 文章编辑器 / 动态编辑器。
 * DEV 模式下保存动作接收 .md / .zip 下载响应。
 */
import { mountDialogs } from "./dialogs.js";
import { AutosaveController, restoreDraft } from "./autosave.js";
import { attachInlineImages } from "./inline-images.js";
import { renderExtendedSyntax } from "./ext-preview.js";

// 对话框注册表（启动时挂载）
let DIALOGS = {};

const $app = document.getElementById("app");
const state = {
  devMode: false,
  view: "posts",
  tags: { post: [], moment: [] },
  current: { post: null, moment: null, timeline: null },
  editors: {},
  momentImages: [],
  taxonomies: null, // { tags: [{name,posts,moments,total}], categories: [{name,count}] }，null = 未加载
};

// 时间线：全量节点 + 分类（GET /timeline 一次拉齐；编辑靠快照定位，不单独拉详情）
let timelineCache = [];
let timelineCategories = [];

// ---------- Ctrl/Cmd+S 保存快捷键（document 级兜底，含 EasyMDE 外的 textarea/表单场景） ----------
function saveShortcutHandler(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key !== "s" && e.key !== "S") return;
  const post = qs("#btn-save-post");
  const moment = qs("#btn-save-moment");
  const timeline = qs("#btn-save-timeline");
  const target = post && !post.disabled ? post : moment || timeline; // 同屏只存在一种编辑器
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  // 编辑中且有自动保存控制器：Ctrl+S 语义 = 存服务器暂存（不推 git）
  if (state.current.autosave) {
    state.current.autosave.saveNow();
    return;
  }
  target.click();
}
let saveShortcutBound = false; // renderShell 可重复调用，防重复注册

// ---------- API ----------

// 相对路径发请求：经反向代理挂在任意子路径（如 域名/blog-admin/）时，
// 从浏览器当前 URL 叠加（/blog-admin/ + api/xxx），无需感知前缀。
async function api(path, options = {}) {
  const res = await fetch(`api${path}`, {
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...options,
    body: options.body instanceof FormData || typeof options.body === "string" ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("text/markdown") || contentType.includes("application/zip")) {
    return { download: res, filename: res.headers.get("X-Suggested-Filename") || "download.md" };
  }
  // 非 JSON 响应（如反代/WAF 拦截页、路由 404 的 HTML）直接报状态码，避免误导性的"响应解析失败"
  if (!contentType.includes("application/json")) {
    throw new Error(`请求失败（${res.status}，非 JSON 响应——检查路径或反向代理）`);
  }
  const json = await res.json().catch(() => ({ ok: false, error: `响应解析失败（${res.status}）` }));
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
      loadTaxonomies(); // 异步预取已有标签/分类（编辑器打开时直接可用）
      renderShell();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

// ---------- 健康数据警示点（纯展示：凭证/同步异常时红点，管理动作归运维配置文件） ----------

function mountHealthAlert() {
  const el = document.getElementById("health-alert");
  if (!el) return;
  const check = async () => {
    try {
      const s = await api("/health/alert");
      const bad = s.configured && (s.credentialStale || s.syncStalled);
      el.hidden = !bad;
      if (bad) {
        const why = s.credentialStale ? "凭证续期失败" : "数据同步停滞";
        el.title = `健康数据链路异常（${why}）：MIHEALTH_DB 同目录 config.json 需运维重新生成；详情看服务器日志`;
      }
    } catch {
      el.hidden = true; // 查询失败不提示（未配置 MIHEALTH_DB 属正常）
    }
  };
  check();
  setInterval(check, 10 * 60 * 1000); // 10 分钟一查
}

// ---------- 主框架 ----------

function renderShell() {
  $app.innerHTML = "";
  const shell = document.getElementById("tpl-shell").content.cloneNode(true);
  $app.appendChild(shell);

  if (!saveShortcutBound) {
    document.addEventListener("keydown", saveShortcutHandler);
    saveShortcutBound = true;
  }
  if (state.devMode) document.getElementById("dev-badge").hidden = false;
  else {
    document.getElementById("btn-sync").hidden = false; // 仅生产模式显示同步按钮
    document.getElementById("btn-deploy").hidden = false; // 拉取站点按钮（部署功能未配置时后端返回 503）
  }
  mountHealthAlert();

  // 拉取站点：手动重试部署（Actions 链路偶发 git 超时失败的补救）
  const deployBtn = document.getElementById("btn-deploy");
  if (deployBtn && !deployBtn.hidden) {
    deployBtn.addEventListener("click", async () => {
      if (deployBtn.disabled) return;
      deployBtn.disabled = true;
      deployBtn.textContent = "拉取中…";
      try {
        const r = await api("/deploy/retry", { method: "POST" });
        // 轮询直至结束（最长 6 分钟：慢网下 git 操作 300s 超时上限）
        const deadline = Date.now() + 6 * 60 * 1000;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const s = await api(`/deploy/retry/status?ticket=${encodeURIComponent(r.ticket)}`);
          if (s.state === "running") {
            if (Date.now() > deadline) {
              toast("拉取耗时过长已停止等待；可稍后重试或查看服务器日志", true);
              break;
            }
            continue;
          }
          if (s.state === "done") {
            toast(`站点已更新到构建产物 ${(s.head || "").slice(0, 7)}`);
          } else {
            toast(`拉取失败：${s.error || "未知错误"}`, true);
          }
          break;
        }
      } catch (err) {
        toast(err.message, true);
      } finally {
        deployBtn.disabled = false;
        deployBtn.textContent = "拉取站点";
      }
    });
  }

  // 同步：触发 → 轮询进度 → 刷新列表；页面加载时若已有同步在跑则自动接上进度
  const syncBtn = document.getElementById("btn-sync");
  if (syncBtn && !syncBtn.hidden) {
    // 远端落后检测：用户 git push 后提示同步（自身提交不误报，见 store.remoteAhead）
    const checkRemote = async () => {
      try {
        const s = await api("/remote-status");
        const behind = s.remoteAhead === true;
        syncBtn.classList.toggle("btn-remote-ahead", behind);
        syncBtn.title = behind ? "远端有新提交（如你用 git 推送过修改），点击同步拉取" : "从 GitHub 拉取最新内容到本地镜像";
      } catch {
        /* 查询失败不提示 */
      }
    };
    state.checkRemoteAhead = checkRemote;
    checkRemote();

    syncBtn.addEventListener("click", async () => {
      if (syncBtn.disabled) return;
      syncBtn.disabled = true;
      syncBtn.textContent = "同步中…";
      try {
        await api("/sync", { method: "POST" });
        await watchSyncProgress(syncBtn);
      } catch (err) {
        toast(err.message, true);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = "⟳ 同步";
        checkRemote();
      }
    });
    // 刷新页面后恢复：后台同步不随页面关闭而中止（single-flight 跑在服务器进程里）
    (async () => {
      try {
        const s = await api("/sync/status");
        if (s.status === "running") {
          syncBtn.disabled = true;
          syncBtn.textContent = "同步中…";
          await watchSyncProgress(syncBtn);
          syncBtn.disabled = false;
          syncBtn.textContent = "同步";
        }
      } catch {
        /* 状态查询失败不打扰用户 */
      }
    })();
  }

  document.getElementById("btn-logout").addEventListener("click", async () => {
    await api("/logout", { method: "POST" }).catch(() => {});
    renderLogin();
  });

  // 侧边栏展开/收起：同一列按钮原地向右展开文字标签（覆盖浮层带阴影 + 遮罩）。
  // 移动端（≤768px）恢复顶部常驻横条——标签常显、无展开概念，点击顶钮不切换。
  const sidebar = document.getElementById("sidebar");
  const mask = document.getElementById("sidebar-mask");
  const isMobileLayout = () => window.matchMedia("(max-width: 768px)").matches;
  const openRail = () => {
    if (isMobileLayout()) return;
    sidebar.classList.add("open");
    mask.hidden = false;
  };
  const closeRail = () => {
    sidebar.classList.remove("open");
    mask.hidden = true;
  };
  const toggleRail = () => (sidebar.classList.contains("open") ? closeRail() : openRail());
  document.getElementById("btn-menu").addEventListener("click", (e) => {
    if (isMobileLayout()) return; // 移动端顶钮仅作品牌展示
    e.stopPropagation();
    toggleRail();
  });
  mask.addEventListener("click", closeRail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRail();
  });
  // 窗口缩到移动端布局时收起展开态（横条形态下残留 open 类会有阴影样式）
  window.addEventListener("resize", () => {
    if (isMobileLayout()) closeRail();
  });
  state.closeRail = closeRail;

  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => {
      switchView(btn.dataset.view);
      closeRail(); // 展开态点导航后自动收起（桌面）；移动端 closeRail 无副作用
    });
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
  else if (view === "timeline") renderTimelineList();
}

/** 同步完成后刷新当前视图（顺带重查远端状态与标签/分类候选池） */
function refreshCurrentView() {
  if (typeof state.checkRemoteAhead === "function") state.checkRemoteAhead();
  loadTaxonomies(); // 镜像已更新，重新聚合标签/分类
  return switchView(state.view);
}

/** 轮询同步进度直至结束（按钮触发与页面刷新恢复共用） */
async function watchSyncProgress(syncBtn) {
  // 硬上限 45 分钟：国内服务器到 codeload 可能极慢，50MB 需 40+ 分钟
  const deadline = Date.now() + 45 * 60 * 1000;
  let lastBytes = 0;
  let lastBytesAt = Date.now();
  const barWrap = document.getElementById("sync-progress");
  const bar = document.getElementById("sync-progress-bar");
  const setBar = (pct) => { if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`; };
  const setIndeterminate = () => { if (bar) { bar.classList.add("indeterminate"); bar.style.width = "100%"; } };
  const setDeterminate = (pct) => { if (bar) { bar.classList.remove("indeterminate"); setBar(pct); } };
  if (barWrap) barWrap.hidden = false;
  const hideBar = () => { if (barWrap) barWrap.hidden = true; };
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api("/sync/status");
      if (s.status === "running") {
        const mb = (s.bytes / 1048576).toFixed(1);
        if (s.phase === "extracting" || (s.files && !s.totalBytes && !s.estBytes)) {
          // 解压阶段（无总大小可算）：条纹动画表示进行中
          syncBtn.textContent = `解压中 ${s.files} 文件`;
          setIndeterminate();
        } else if (s.phase === "connecting") {
          syncBtn.textContent = "连接 GitHub…";
          setIndeterminate();
        } else {
          // 下载阶段：优先真实 Content-Length，缺失时用上次 tarball 大小估算
          const total = s.totalBytes || s.estBytes;
          if (total) {
            const pct = Math.min(100, Math.round((s.bytes / total) * 100));
            setDeterminate(pct);
            if (s.bytes > lastBytes) {
              if (lastBytes > 0) {
                const rate = (s.bytes - lastBytes) / ((Date.now() - lastBytesAt) / 1000);
                const remain = rate > 0 ? (total - s.bytes) / rate : null;
                syncBtn.textContent = remain != null
                  ? `↓${mb}MB ${pct}% 约${remain > 90 ? `${Math.round(remain / 60)}分` : `${Math.round(remain)}秒`}`
                  : `↓${mb}MB ${pct}%`;
              } else {
                syncBtn.textContent = `↓${mb}MB ${pct}%`;
              }
              lastBytes = s.bytes;
              lastBytesAt = Date.now();
            }
          } else {
            syncBtn.textContent = `↓${mb}MB`;
            setIndeterminate();
          }
        }
        if (Date.now() > deadline) {
          toast("同步耗时过长已停止等待；后台可能仍在进行，稍后刷新页面查看结果", true);
          break;
        }
        continue;
      }
      if (s.status === "ok") {
        setDeterminate(100);
        setTimeout(hideBar, 600); // 满格短暂停留后收起
        toast(`同步完成：${s.files} 文件（${(s.meta?.syncedAt || "").slice(0, 19).replace("T", " ")}）`);
        await refreshCurrentView();
      } else {
        hideBar();
        toast(`同步失败：${s.error || "未知错误"}`, true);
      }
      break;
    }
  } catch (err) {
    hideBar();
    throw err;
  }
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
          ${m.imageCount ? `<span class="badge"><i class="fa fa-picture-o"></i> ${m.imageCount}</span>` : ""}
        </div>
        <div class="cc-sub">${esc([m.location, ...(m.tags || []).map((t) => `#${t}`)].filter(Boolean).join(" "))}</div>
      </div>
      <div class="cc-meta">${esc(m.published)}</div>`;
    card.addEventListener("click", () => openMomentEditor(m.id));
    listEl.appendChild(card);
  }
}

// ---------- 时间线列表 ----------

async function renderTimelineList() {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.appendChild(document.getElementById("tpl-timeline").content.cloneNode(true));

  document.getElementById("btn-new-timeline").addEventListener("click", () => openTimelineEditor(null));
  document.getElementById("timeline-search").addEventListener("input", drawTimeline);

  const listEl = document.getElementById("timeline-list");
  listEl.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const data = await api("/timeline");
    timelineCache = data.items || [];
    timelineCategories = data.categories || [];
    drawTimeline();
  } catch (err) {
    listEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function drawTimeline() {
  const listEl = document.getElementById("timeline-list");
  const q = document.getElementById("timeline-search").value.trim().toLowerCase();

  const catLabel = (key) => {
    const c = timelineCategories.find((c) => c.key === key);
    return c ? c.label : key;
  };

  const items = timelineCache
    .map((item, index) => ({ item, index })) // 保留原始下标供编辑器快照定位
    .filter(({ item }) => {
      if (!q) return true;
      return [item.title, item.subtitle, item.description, ...(item.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

  if (!items.length) {
    listEl.innerHTML = `<div class="empty">没有符合条件的时间线节点</div>`;
    return;
  }
  listEl.innerHTML = "";
  for (const { item, index } of items) {
    const card = document.createElement("div");
    card.className = "content-card";
    card.innerHTML = `
      <div class="cc-main">
        <div class="cc-title">${esc(item.title)}
          ${item.featured ? '<span class="badge badge-pinned"><i class="fa fa-star"></i> 重点</span>' : ""}
          ${item.enable === false ? '<span class="badge badge-draft">已隐藏</span>' : ""}
          ${item.category ? `<span class="badge">${esc(catLabel(item.category))}</span>` : ""}
        </div>
        <div class="cc-sub">${esc([item.subtitle, ...(item.tags || []).map((t) => `#${t}`)].filter(Boolean).join(" "))}</div>
      </div>
      <div class="cc-meta">${esc(item.date)}</div>`;
    card.addEventListener("click", () => openTimelineEditor(index));
    listEl.appendChild(card);
  }
}

// ---------- 时间线节点编辑器 ----------

async function openTimelineEditor(index) {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.appendChild(document.getElementById("tpl-timeline-editor").content.cloneNode(true));

  const isNew = index == null;
  const original = isNew ? null : timelineCache[index];
  if (!isNew && !original) {
    toast("节点不存在，请返回列表刷新", true);
    renderTimelineList();
    return;
  }
  // 快照深拷贝：original 随服务端重读比对，item 单独留存初始值供回填比对
  state.current.timeline = { index: isNew ? null : index, original: original ? JSON.parse(JSON.stringify(original)) : null };
  const item = original || {};

  qs("#te-title").value = item.title || "";
  qs("#te-date").value = item.date || "";
  qs("#te-subtitle").value = item.subtitle || "";
  qs("#te-location").value = item.location || "";
  qs("#te-icon").value = item.icon || "";
  qs("#te-description").value = item.description || "";
  qs("#te-featured").checked = item.featured === true;
  qs("#te-disabled").checked = item.enable === false;

  // 分类下拉：空选项 + yaml 分类清单
  const catSel = qs("#te-category");
  catSel.innerHTML =
    `<option value="">（无分类）</option>` +
    timelineCategories
      .map((c) => `<option value="${esc(c.key)}"${item.category === c.key ? " selected" : ""}>${esc(c.label || c.key)}</option>`)
      .join("");
  if (!timelineCategories.length) {
    const opt = document.createElement("option");
    opt.value = item.category || "";
    opt.textContent = item.category ? `${item.category}（yaml 未配置分类，保留原值）` : "（无分类）";
    catSel.innerHTML = "";
    catSel.appendChild(opt);
  }

  // 标签（复用文章/动态的标签输入交互；kind 独立避免互串）
  state.tags.timeline = Array.isArray(item.tags) ? [...item.tags] : [];
  drawTimelineTags();

  // 要点列表
  state.timelineHighlights = Array.isArray(item.highlights) ? item.highlights.map(String) : [];
  drawHighlights();
  qs("#btn-add-highlight").addEventListener("click", () => {
    state.timelineHighlights.push("");
    drawHighlights(true);
  });

  // 关联链接
  state.timelineLinks = Array.isArray(item.links) ? item.links.map((l) => ({ ...l })) : [];
  drawLinks();
  qs("#btn-add-link").addEventListener("click", () => {
    state.timelineLinks.push({ label: "", url: "", icon: "" });
    drawLinks(true);
  });

  qs("#btn-save-timeline").addEventListener("click", saveTimelineItem);
  qs("#btn-back").addEventListener("click", renderTimelineList);
  qs("#btn-delete-timeline").addEventListener("click", deleteTimelineItem);

  // ---- 自动保存（DEV 停用）：整个编辑表单作为一个快照，id 固定 main ----
  if (!state.devMode) {
    const collectTimelineForm = () => ({
      form: {
        title: qs("#te-title").value.trim(),
        date: qs("#te-date").value.trim(),
        category: qs("#te-category").value,
        subtitle: qs("#te-subtitle").value.trim(),
        location: qs("#te-location").value.trim(),
        icon: qs("#te-icon").value.trim(),
        description: qs("#te-description").value.trim(),
        tags: state.tags.timeline,
        highlights: state.timelineHighlights,
        links: state.timelineLinks,
        featured: qs("#te-featured").checked,
        enable: !qs("#te-disabled").checked,
      },
      body: "",
      // 快照定位信息存 baseSha（原节点 + 下标，推送时服务端重读比对）
      baseSha: JSON.stringify({ index: state.current.timeline.index, original: state.current.timeline.original }),
    });
    const autosave = new AutosaveController({
      kind: "timeline",
      draftId: "main",
      collect: collectTimelineForm,
    });
    state.current.autosave = autosave;
    autosave.bindStatus(qs("#autosave-status-timeline"), qs("#autosave-banner-timeline"));

    // 恢复暂存（只回填表单，不自动覆盖定位快照：用户确认后保存生效）
    const snap = await restoreDraft("timeline", "main");
    if (snap?.form) {
      const f = snap.form;
      qs("#te-title").value = f.title || "";
      qs("#te-date").value = f.date || "";
      qs("#te-subtitle").value = f.subtitle || "";
      qs("#te-location").value = f.location || "";
      qs("#te-icon").value = f.icon || "";
      qs("#te-description").value = f.description || "";
      qs("#te-featured").checked = f.featured === true;
      qs("#te-disabled").checked = f.enable === false;
      if (Array.isArray(f.tags)) {
        state.tags.timeline = [...f.tags];
        drawTimelineTags();
      }
      if (Array.isArray(f.highlights)) {
        state.timelineHighlights = f.highlights.map(String);
        drawHighlights();
      }
      if (Array.isArray(f.links)) {
        state.timelineLinks = f.links.map((l) => ({ ...l }));
        drawLinks();
      }
      const at = new Date(snap.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      autosave.showBanner(`已载入 ${at} 的时间线自动保存`, () => {});
      autosave.lastSnapshot = JSON.stringify({ form: f, body: "" });
    }

    // 输入标脏：整卡事件委托（表单字段多，逐个绑定冗余）
    main.addEventListener("input", () => autosave.markDirty());
    main.addEventListener("change", () => autosave.markDirty());
    qs("#btn-back").addEventListener("click", () => autosave.destroy());
    qs("#btn-save-timeline").addEventListener("click", () => autosave.destroy(), { once: true });
    qs("#btn-delete-timeline").addEventListener("click", () => autosave.destroy());
  }

  // 表单卡钉底（与文章左栏同款设计语言）；单列布局自动禁用
  setupCardPinBottom(".timeline-editor", "#main");
}

/** 时间线标签输入：不复用 drawTags(kind) 的 post/moment 选择器硬编码，单独绑定 */
function drawTimelineTags() {
  const box = qs("#te-tag-box");
  const input = qs("#te-tags");
  if (!box) return;
  box.innerHTML = "";
  for (const tag of state.tags.timeline) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `#${esc(tag)} <button type="button" title="移除">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      state.tags.timeline = state.tags.timeline.filter((t) => t !== tag);
      drawTimelineTags();
    });
    box.appendChild(chip);
  }
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = input.value.trim().replace(/^#/, "");
      if (val && !state.tags.timeline.some((t) => t.toLowerCase() === val.toLowerCase())) {
        state.tags.timeline.push(val);
        drawTimelineTags();
      }
      input.value = "";
    }
  };
}

/** 绘制要点输入行；focusLast = 新增行自动聚焦 */
function drawHighlights(focusLast = false) {
  const listEl = qs("#te-highlights");
  if (!listEl) return;
  listEl.innerHTML = "";
  state.timelineHighlights.forEach((text, idx) => {
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `<input type="text" class="hl-input" placeholder="如：接入自动化构建与部署流程" value="${esc(text)}" />
      <button type="button" class="fr-remove" title="删除此条">×</button>`;
    row.querySelector("input").addEventListener("input", (e) => {
      state.timelineHighlights[idx] = e.target.value;
    });
    row.querySelector(".fr-remove").addEventListener("click", () => {
      state.timelineHighlights.splice(idx, 1);
      drawHighlights();
    });
    listEl.appendChild(row);
  });
  if (focusLast && listEl.lastElementChild) listEl.lastElementChild.querySelector("input").focus();
}

/** 绘制链接三字段行；focusLast = 新增行自动聚焦 */
function drawLinks(focusLast = false) {
  const listEl = qs("#te-links");
  if (!listEl) return;
  listEl.innerHTML = "";
  state.timelineLinks.forEach((link, idx) => {
    const row = document.createElement("div");
    row.className = "item-row link-row";
    row.innerHTML = `
      <div class="field-row link-fields">
        <label class="field"><span class="field-label">名称 *</span>
          <input type="text" class="lk-label" value="${esc(link.label || "")}" placeholder="如：主题源码" /></label>
        <label class="field"><span class="field-label">URL *</span>
          <input type="text" class="lk-url" value="${esc(link.url || "")}" placeholder="https://…" /></label>
        <label class="field"><span class="field-label">图标（可选）</span>
          <input type="text" class="lk-icon" value="${esc(link.icon || "")}" placeholder="fa6-brands:github" /></label>
      </div>
      <button type="button" class="fr-remove" title="删除此条">×</button>`;
    row.querySelector(".lk-label").addEventListener("input", (e) => (state.timelineLinks[idx].label = e.target.value));
    row.querySelector(".lk-url").addEventListener("input", (e) => (state.timelineLinks[idx].url = e.target.value));
    row.querySelector(".lk-icon").addEventListener("input", (e) => (state.timelineLinks[idx].icon = e.target.value));
    row.querySelector(".fr-remove").addEventListener("click", () => {
      state.timelineLinks.splice(idx, 1);
      drawLinks();
    });
    listEl.appendChild(row);
  });
  if (focusLast && listEl.lastElementChild) listEl.lastElementChild.querySelector(".lk-label").focus();
}

/** 组装表单 → PUT /timeline（create/update 共用） */
async function saveTimelineItem() {
  const cur = state.current.timeline;
  const isNew = cur.original == null;
  const item = {
    title: qs("#te-title").value.trim(),
    date: qs("#te-date").value.trim(),
    category: qs("#te-category").value,
    subtitle: qs("#te-subtitle").value.trim(),
    location: qs("#te-location").value.trim(),
    icon: qs("#te-icon").value.trim(),
    description: qs("#te-description").value.trim(),
    tags: state.tags.timeline,
    highlights: state.timelineHighlights.map((s) => s.trim()).filter(Boolean),
    links: state.timelineLinks,
    featured: qs("#te-featured").checked,
    enable: !qs("#te-disabled").checked, // 表单语义为“隐藏”，取反映射回 enable
  };
  if (!item.title || !item.date) {
    toast("标题与日期不能为空", true);
    return;
  }

  const btn = qs("#btn-save-timeline");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const res = await api("/timeline", {
      method: "PUT",
      body: {
        op: isNew ? "create" : "update",
        index: isNew ? undefined : cur.index,
        original: cur.original,
        item,
      },
    });
    if (res.download) {
      triggerDownload(res.download, res.filename);
      toast(`DEV 模式：已生成下载（${res.filename}）`);
    } else {
      toast(`${res.message}${res.commitUrl ? "，已推送 GitHub" : ""}`);
    }
    renderTimelineList();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

async function deleteTimelineItem() {
  const cur = state.current.timeline;
  if (cur.original == null) {
    renderTimelineList(); // 新建未保存直接返回
    return;
  }
  if (!confirm(`确定删除节点「${cur.original.title}」？此操作${state.devMode ? "在 DEV 模式下无副作用" : "会提交删除到 GitHub 仓库"}`)) return;
  try {
    const res = await api("/timeline", {
      method: "PUT",
      body: { op: "delete", index: cur.index, original: cur.original },
    });
    if (res.download) {
      triggerDownload(res.download, res.filename);
      toast(`DEV 模式：已生成下载（${res.filename}）`);
    } else {
      toast(res.message || "已删除");
    }
    renderTimelineList();
  } catch (err) {
    toast(err.message, true);
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

  // 自动保存控制器（DEV 模式停用：保存动作是下载，无服务器暂存语义）
  const autosaveId = () => {
    const s = qs("#pe-slug")?.value.trim();
    return s || `_new-${state.current.post.tempKey}`;
  };
  const autosave = state.devMode
    ? null
    : new AutosaveController({
        kind: "post",
        draftId: autosaveId,
        collect: () => {
          const s = qs("#pe-slug")?.value.trim();
          if (!s) throw new Error("slug 未填"); // 无 slug 不落暂存
          // 暂存图清单：正文已传图 + 封面（封面不在正文，显式带上保证多端续写可见）
          const imgs = [...(state.current.post.images || [])];
          const coverRef = qs("#pe-image")?.value.trim() || "";
          if (coverRef && !/^(https?:|data:)/i.test(coverRef)) {
            const coverPath = `content/posts/${s}/${coverRef.replace(/^\.\//, "")}`;
            if (!imgs.some((i) => i.repoPath === coverPath)) {
              imgs.push({ repoPath: coverPath, name: coverPath.split("/").pop() });
            }
          }
          return { ...collectPostForm(), body: state.editors.post.value(), images: imgs, baseSha: post.sha };
        },
      });
  state.current.autosave = autosave;
  if (!state.current.post.tempKey) state.current.post.tempKey = Date.now().toString(36);
  if (autosave) autosave.bindStatus(qs("#autosave-status-post"), qs("#autosave-banner-post"));

  // 表单回填
  const fm = post.frontmatter || {};
  qs("#pe-title").value = fm.title || "";
  qs("#pe-slug").value = post.slug || "";
  qs("#pe-slug").readOnly = !isNew;
  if (!isNew) qs("#pe-slug").title = "编辑模式下 slug 不可修改（避免破坏已发布链接）";
  qs("#pe-category").value = fm.category || "";
  qs("#pe-image").value = fm.image || "";
  // 封面图：已有封面（./cover.webp 或外链）回填缩略图/按钮态
  renderCoverState(fm.image || "", post.slug);
  qs("#pe-description").value = fm.description || "";
  qs("#pe-pinned").checked = fm.pinned === true;
  qs("#pe-draft").checked = fm.draft === true;
  qs("#pe-comment").checked = fm.comment !== false;
  qs("#pe-refresh-updated").closest("label").hidden = isNew;
  state.tags.post = Array.isArray(fm.tags) ? [...fm.tags] : [];
  drawTags("post");
  drawTagSuggestions("post");
  fillCategoryOptions();

  // 草稿勾选联动：保存按钮在“发布 / 暂存”间切换（草稿同步推仓，仅站点隐藏）
  const syncPostSaveBtn = () => {
    const btn = qs("#btn-save-post");
    if (!btn || btn.disabled) return;
    btn.textContent = qs("#pe-draft").checked ? "暂存" : "发布";
    btn.classList.toggle("btn-staged", qs("#pe-draft").checked);
    const hint = qs("#pe-draft").closest("label").querySelector("span");
    if (hint) hint.textContent = qs("#pe-draft").checked ? "草稿（同步仓库，生产站点隐藏）" : "草稿（生产站点隐藏）";
  };
  qs("#pe-draft").addEventListener("change", syncPostSaveBtn);
  syncPostSaveBtn();

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
  // 预览时把文章内相对/根路径图片重写为 /api/asset 代理 URL，
 // 否则浏览器请求 admin 源站舍径拿不到图片（线上站点才有这些资源）
  const rewritePreviewImages = (html) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    for (const img of tpl.content.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src");
      if (/^(https?:|data:|blob:)/i.test(src)) continue; // 外链/dataURL 不动
      let repoPath;
      if (src.startsWith("./") || !src.startsWith("/")) {
        repoPath = `content/posts/${post.slug}/${src.replace(/^\.?\//, "")}`;
      } else {
        repoPath = `public${src.split("?")[0]}`;
      }
      img.setAttribute("src", assetUrl(repoPath));
    }
    return tpl.innerHTML;
  };
  const mde = new EasyMDE({
    element: qs("#pe-md"),
    initialValue: initial,
    spellChecker: false,
    extraKeys: {
      // CodeMirror 捕获焦点按键，document 监听收不到，双保险。
      // 语义随批次2变更：有自动保存控制器时存服务器暂存，否则触发保存按钮
      "Ctrl-S": () => {
        if (state.current.autosave) state.current.autosave.saveNow();
        else qs("#btn-save-post")?.click();
      },
      "Cmd-S": () => {
        if (state.current.autosave) state.current.autosave.saveNow();
        else qs("#btn-save-post")?.click();
      },
    },
    previewRender: (plainText, preview) => {
      // 先把主题扩展语法转近似 HTML，再用内置 marked 渲染，最后重写图片 src
      const extended = renderExtendedSyntax(plainText);
      const rendered = EasyMDE.prototype.markdown.call(mde, extended);
      preview.innerHTML = rewritePreviewImages(rendered);
      return null;
    },
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

  // 行内图片：图片引用行下方挂缩略图（src 解析与 rewritePreviewImages 同套规则）
  const inlineImages = attachInlineImages(mde, {
    repoPathOf: (src) => {
      if (src.startsWith("./") || !src.startsWith("/")) {
        return `content/posts/${post.slug}/${src.replace(/^\.?\//, "")}`;
      }
      return `public${src.split("?")[0]}`;
    },
  });
  state.editors.postInlineImages = inlineImages;

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

  // 封面图上传：固定 cover.<ext> 覆盖式；成功后缩略图 + 按钮变「重新上传」
  setupCoverUpload({
    getSlug: () => qs("#pe-slug").value.trim(),
    onSaved: (ref) => {
      qs("#pe-image").value = ref;
      autosave?.markDirty();
    },
  });

  // 保存
  qs("#btn-save-post").addEventListener("click", () => savePost(isNew));
  qs("#btn-back").addEventListener("click", () => renderPostsList());
  qs("#btn-delete-post").addEventListener("click", () => deleteContent("post", post.slug));

  drawUploadList(); // 已传图回填（重开编辑器时可管理：预览/插入引用/移除）

  // ---- 自动保存：恢复较新暂存 + 输入标脏 ----
  if (autosave) {
    const snap = await restoreDraft("post", autosaveId());
    if (snap && (isNew || snap.savedAt > (post.frontmatter?.updatedAt || post.frontmatter?.publishedAt || ""))) {
      // 暂存比仓库新：回填表单 + 横幅提示
      qs("#pe-title").value = snap.form?.title || "";
      if (isNew) qs("#pe-slug").value = snap.form?.slug || "";
      qs("#pe-category").value = snap.form?.category || "";
      qs("#pe-image").value = snap.form?.image || "";
      renderCoverState(snap.form?.image || "", qs("#pe-slug").value.trim()); // 封面缩略图随暂存联动
      qs("#pe-description").value = snap.form?.description || "";
      qs("#pe-pinned").checked = snap.form?.pinned === true;
      qs("#pe-draft").checked = snap.form?.draft === true;
      qs("#pe-comment").checked = snap.form?.comment !== false;
      if (Array.isArray(snap.form?.tags)) {
        state.tags.post = [...snap.form.tags];
        drawTags("post");
      }
      if (snap.body) state.editors.post.value(snap.body);
      if (Array.isArray(snap.images)) {
        // 合并暂存图（去重）
        const known = new Set((state.current.post.images || []).map((i) => i.repoPath));
        for (const img of snap.images) {
          if (img?.repoPath && !known.has(img.repoPath)) state.current.post.images.push(img);
        }
        drawUploadList();
      }
      const at = new Date(snap.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      autosave.showBanner(`已载入 ${at} 的自动保存草稿`, () => {});
      autosave.lastSnapshot = JSON.stringify(snap.form ? { ...snap.form, body: snap.body, images: snap.images } : "");
      syncPostSaveBtn();
    }

    // 输入监听：元信息表单 + 编辑器正文 + 标签
    for (const sel of ["#pe-title", "#pe-slug", "#pe-category", "#pe-image", "#pe-description", "#pe-pinned", "#pe-draft", "#pe-comment"]) {
      qs(sel)?.addEventListener("input", () => autosave.markDirty());
      qs(sel)?.addEventListener("change", () => autosave.markDirty());
    }
    state.editors.post.codemirror.on("change", () => autosave.markDirty());
    qs("#btn-back").addEventListener("click", () => { autosave.destroy(); state.editors.postInlineImages?.destroy(); });
    qs("#btn-save-post").addEventListener("click", () => { autosave.destroy(); state.editors.postInlineImages?.destroy(); }, { once: true });
  }

  // 左栏钉底：元信息卡底部到达视口底时固定（正文继续滚）；单列布局（含移动端）自动禁用
  setupCardPinBottom(".editor-meta", ".editor-grid");
}

/**
 * 卡片钉底控制器（设计语言统一：文章左栏 / 动态表单卡 / 时间线表单卡同款）：
 * - 卡片随页面滚动；底部到达视口底时 translateY 钉住（后续内容继续滚）
 * - 位移上限 = 参照容器高 - 卡片高（滚到页尾随内容离开，不悬空）
 * - Chrome 系 grid/flex item 的 sticky bottom 不生效（已知 bug），故 JS 实现；
 *   原生 sticky 生效的浏览器自动跳过接管
 * - 单列布局（≤960px，含移动端）：卡片与正文同列，钉住会遮正文——禁用
 * @param cardSel 卡片选择器；boundSel 钉底范围参照（通常是卡片所在的容器）
 */
function setupCardPinBottom(cardSel, boundSel) {
  const card = qs(cardSel);
  const bound = qs(boundSel);
  if (!card || !bound) return;

  // 单列布局禁用（含移动端：所有卡片纵排，固定反而突兀）
  const singleCol = () => window.matchMedia("(max-width: 960px)").matches;

  let raf = null;
  const update = () => {
    raf = null;
    if (singleCol()) {
      card.style.transform = "";
      card.classList.remove("pin-bottom");
      return;
    }
    const vh = window.innerHeight;
    const dyMax = bound.offsetHeight - card.offsetHeight;
    if (dyMax <= 0) {
      card.style.transform = "";
      card.classList.remove("pin-bottom");
      return;
    }
    // 自然文档位置底部（offsetTop 不含 transform）
    const naturalBottom = card.offsetTop + card.offsetHeight;
    const dy = Math.max(0, Math.min(window.scrollY + vh - naturalBottom, dyMax));
    if (dy > 0) {
      card.classList.add("pin-bottom");
      card.style.transform = `translateY(${dy}px)`;
    } else {
      card.classList.remove("pin-bottom");
      card.style.transform = "";
    }
  };
  const onScroll = () => {
    if (raf == null) raf = requestAnimationFrame(update);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();

  // 卸载清理（返回/保存/删除后 main 重绘）
  const teardown = () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    if (raf != null) cancelAnimationFrame(raf);
    card.style.transform = "";
    card.classList.remove("pin-bottom");
  };
  for (const sel of ["#btn-back", "#btn-save-post", "#btn-save-moment", "#btn-save-timeline",
    "#btn-delete-post", "#btn-delete-moment", "#btn-delete-timeline"]) {
    qs(sel)?.addEventListener("click", teardown, { once: true });
  }
  // 兜底：main 被整体重绘（其它路径导航）时元素已从 DOM 移除，监听器成孤儿——
  // 用 MutationObserver 检测卡片脱离文档即自动 teardown
  const mo = new MutationObserver(() => {
    if (!card.isConnected) {
      mo.disconnect();
      teardown();
    }
  });
  mo.observe(document.getElementById("main"), { childList: true, subtree: true });
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
  // 暂存图清单随推送提交：后端 absorbAfterPush 据此搬运。
  // 已传图清单 + 封面（封面在 frontmatter 不在正文，必须显式带上才能随发布推送）
  const coverRef = qs("#pe-image")?.value.trim() || "";
  const coverPath = coverRef && !/^(https?:|data:)/i.test(coverRef)
    ? `content/posts/${form.slug}/${coverRef.replace(/^\.\//, "")}`
    : null;
  const staged = [...(state.current.post?.images || [])];
  if (coverPath && !staged.some((i) => i.repoPath === coverPath)) {
    staged.push({ repoPath: coverPath, name: coverPath.split("/").pop() });
  }
  const payload = { form, body, stagedImages: staged };
  const btn = qs("#btn-save-post");
  const isDraft = form.draft === true;
  btn.disabled = true;
  btn.textContent = isDraft ? "暂存中…" : "发布中…";
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
    loadTaxonomies(); // 新写入的标签/分类即时进入候选池
    // 发布成功后返回列表页（异步刷新标签池，不阻塞导航）
    renderPostsList();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = isDraft ? "暂存" : "发布";
  }
}

// ---------- 动态编辑器 ----------

const MOODS = [
  { icon: "material-symbols:sentiment-satisfied-outline-rounded", label: "开心" },
  { icon: "material-symbols:sentiment-excited-outline-rounded", label: "兴奋" },
  { icon: "material-symbols:sentiment-neutral-outline-rounded", label: "专注" },
  { icon: "material-symbols:sentiment-sad-outline-rounded", label: "疲惫" },
  { icon: "material-symbols:lightbulb-outline-rounded", label: "灵感" },
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

  // 自动保存（DEV 停用）；动态新建无 id，用临时键，发布时由后端吸收
  const autosaveId = () => (state.current.moment?.id ? state.current.moment.id : `_new-${state.current.moment?.tempKey || "m"}`);
  const autosave = state.devMode
    ? null
    : new AutosaveController({
        kind: "moment",
        draftId: autosaveId,
        collect: () => ({
          form: {
            location: qs("#me-location").value.trim(),
            mood: selectedMood(),
            tags: state.tags.moment,
            pinned: qs("#me-pinned").checked,
            draft: qs("#me-draft").checked,
            images: state.momentImages,
          },
          body: qs("#me-md").value,
          baseSha: moment.sha,
        }),
      });
  state.current.autosave = autosave;
  if (!state.current.moment.tempKey) state.current.moment.tempKey = Date.now().toString(36);
  if (autosave) autosave.bindStatus(qs("#autosave-status-moment"), qs("#autosave-banner-moment"));
  state.momentImages = Array.isArray(moment.frontmatter?.images) ? moment.frontmatter.images.map((i) => ({ ...i })) : [];

  const fm = moment.frontmatter || {};
  qs("#me-location").value = fm.location || "";
  qs("#me-pinned").checked = fm.pinned === true;
  qs("#me-draft").checked = fm.draft === true;
  state.tags.moment = Array.isArray(fm.tags) ? [...fm.tags] : [];
  drawTags("moment");
  drawTagSuggestions("moment");

  // 草稿勾选联动：发布按钮在“发布 / 暂存”间切换（草稿同步推仓，仅站点隐藏）
  const syncMomentSaveBtn = () => {
    const btn = qs("#btn-save-moment");
    if (!btn || btn.disabled) return;
    btn.textContent = qs("#me-draft").checked ? "暂存" : "发布";
    btn.classList.toggle("btn-staged", qs("#me-draft").checked);
    const hint = qs("#me-draft").closest("label").querySelector("span");
    if (hint) hint.textContent = qs("#me-draft").checked ? "草稿（同步仓库，生产站点隐藏）" : "草稿";
  };
  qs("#me-draft").addEventListener("change", syncMomentSaveBtn);
  syncMomentSaveBtn();

  // 心情选择
  const moodRow = qs("#me-moods");
  moodRow.innerHTML = "";
  for (const m of MOODS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mood-btn";
    btn.title = m.label;
    // 心情用首字做 UI 显示（存 iconify 名进 frontmatter，与站点渲染一致）
    btn.textContent = m.label.slice(0, 1);
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

  // 表单卡钉底（与文章左栏同款设计语言）；单列布局自动禁用
  setupCardPinBottom(".moment-editor", "#main");
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
    btn.textContent = "定位";
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
  // 动态图片随推送提交（九宫格在 frontmatter，无法从正文提取，靠 stagedImages 搬运）
  const payload = { form, body, stagedImages: state.momentImages.map((i) => ({
    repoPath: String(i.src || "").startsWith("/") ? `public${String(i.src).split("?")[0]}` : String(i.src || ""),
  })) };
  const btn = qs("#btn-save-moment");
  const isDraft = form.draft === true;
  btn.disabled = true;
  btn.textContent = isDraft ? "暂存中…" : "发布中…";
  try {
    const res = await api(isNew ? "/moments" : `/moments/${encodeURIComponent(state.current.moment.id)}`, {
      method: isNew ? "POST" : "PUT",
      body: payload,
    });
    if (res.download) {
      triggerDownload(res.download, res.filename);
      toast(`DEV 模式：已生成下载（${res.filename}）`);
    } else {
      toast(`${res.message}${res.commitUrl ? "，已推送 GitHub" : ""}`);
    }
    loadTaxonomies(); // 新写入的标签/分类即时进入候选池
    // 发布成功后返回列表页（异步刷新标签池，不阻塞导航）
    renderMomentsList();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = isDraft ? "暂存" : "发布";
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
  item.textContent = `上传中 ${file.name}…`;
  listEl.appendChild(item);

  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("target", target);
    // 草稿与发布同一存储：图片始终直推仓库，无需区分草稿状态
    if (target === "post") fd.append("slug", qs("#pe-slug").value.trim());
    else fd.append("momentDate", momentDateForUpload());

    const data = await api("/upload", { method: "POST", body: fd });
    // 成功后移除文字状态项，缩略图卡片即反馈
    item.remove();

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
    item.textContent = `失败 ${file.name}: ${err.message}`;
    item.classList.add("fail");
  }
}

// ---------- 封面图上传（固定 cover.<ext>，覆盖式） ----------

/** 封面引用 → 可预览 URL（相对 ./cover.xx 走 asset 代理；外链原样；无封面 null） */
function coverPreviewUrl(ref, slug) {
  if (!ref) return null;
  if (/^(https?:|data:|blob:)/i.test(ref)) return ref; // 外链
  const name = ref.startsWith("./") ? ref.slice(2) : ref;
  return assetUrl(`content/posts/${slug}/${name}`);
}

/**
 * 渲染封面组件状态：无封面 = 「点击上传」；有封面 = 缩略图 + 「重新上传」。
 * ref 为空字符串时回到初始态（外链封面仅展示，同样支持重传覆盖）。
 */
function renderCoverState(ref, slug) {
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
function setupCoverUpload({ getSlug, onSaved }) {
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
      // 相对引用（./cover.webp）与正文图片同口径
      const name = data.repoPath.split("/").pop();
      const ref = `./${name}`;
      renderCoverState(ref, slug);
      onSaved?.(ref);
      toast("封面已上传（保存时随文章推送）");
    } catch (err) {
      toast(`封面上传失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
      // 按当前值重渲染（成功=重新上传；失败=保持原状态），不恢复旧文案
      renderCoverState(qs("#pe-image").value || "", slug);
    }
  });
}

/**
 * 文章已传图清单：缩略图 + 文件名 + 复制引用/删除。
 * 上传成功即时插入（uploadOne），重开编辑器时由 openPostEditor 调用回填。
 */
function drawUploadList() {
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
  // 资源路径用复数（与后端路由 /posts /moments 一致）；kind 仅用于视图刷新与元素选择
  const resource = kind === "post" ? "posts" : "moments";
  try {
    const res = await api(`/${resource}/${encodeURIComponent(id)}`, { method: "DELETE" });
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

/** 仓库路径/web 路径 → 可预览的 URL（admin 下的图片代理，带 Cookie 认证）。
 *  相对路径叠加当前浏览器 URL，反向代理挂在子路径（如 /blog-admin/）时同样成立。 */
function assetUrl(repoPath) {
  return `api/asset?path=${encodeURIComponent(repoPath)}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 标签（手动输入 + 已有标签快速复用） ----------

/** 拉取仓库聚合的标签/分类（失败静默：候选区不显示即可，不影响手动输入） */
async function loadTaxonomies() {
  try {
    state.taxonomies = await api("/taxonomies");
  } catch {
    state.taxonomies = null;
  }
}

/**
 * 文章分类自绘候选区（取代原生 datalist——移动端内部控件体验差且样式失控）：
 * - 输入过滤：键入时只显示匹配项（可完全自定义新分类，候选仅辅助）
 * - 点击填入；已填项再点 = 清除
 * - 候选为空（首次使用）时隐藏，不占空间
 */
function fillCategoryOptions() {
  const box = qs("#pe-cat-suggest");
  const input = qs("#pe-category");
  if (!box || !input) return;

  const render = () => {
    const all = state.taxonomies?.categories || [];
    if (!all.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const q = input.value.trim().toLowerCase();
    // 已填的分类排前（可一键清除），其余按文章数降序；输入时只留匹配项
    const items = [...all]
      .sort((a, b) => b.count - a.count)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .slice(0, 12);
    if (!items.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = "";
    const label = document.createElement("span");
    label.className = "tag-suggest-label";
    label.textContent = "已有分类";
    box.appendChild(label);
    for (const c of items) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-suggest-chip cat-chip";
      chip.title = c.count > 0 ? `${c.count} 篇文章` : "点击填入";
      const active = c.name === input.value.trim();
      if (active) chip.classList.add("cat-chip-active");
      chip.innerHTML = `${esc(c.name)}<span class="tag-suggest-count">${c.count}</span>`;
      chip.addEventListener("click", () => {
        input.value = active ? "" : c.name; // 再点清除
        render();
        input.dispatchEvent(new Event("input", { bubbles: true })); // 触发自动保存标脏
      });
      box.appendChild(chip);
    }
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  render();
}

/**
 * 绘制“已有标签”候选区：点击即添加；输入实时过滤。
 * kind: "post" | "moment"；post 过滤出文章标签（moments>0 也展示但排后），moment 同理。
 */
function drawTagSuggestions(kind) {
  const box = qs(kind === "post" ? "#pe-tag-suggest" : "#me-tag-suggest");
  if (!box) return;
  const input = qs(kind === "post" ? "#pe-tags" : "#me-tags");
  const all = state.taxonomies?.tags || [];
  if (!all.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  // 当前内容类型优先展示该类型用过的标签，另一类型的排后
  const scoped = [...all].sort((a, b) => {
    const av = kind === "post" ? a.posts : a.moments;
    const bv = kind === "post" ? b.posts : b.moments;
    return (bv > 0) - (av > 0);
  });

  const render = () => {
    const q = input.value.trim().replace(/^#/, "").toLowerCase();
    const selected = state.tags[kind].map((t) => t.toLowerCase());
    const items = scoped.filter((t) => !selected.includes(t.name.toLowerCase())).filter((t) => !q || t.name.toLowerCase().includes(q));
    if (!items.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = "";
    const label = document.createElement("span");
    label.className = "tag-suggest-label";
    label.textContent = "已有标签";
    box.appendChild(label);
    const max = 30; // 最多展示 30 个，避免刷屏
    for (const t of items.slice(0, max)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-suggest-chip";
      chip.title = `文章 ${t.posts} 篇 · 动态 ${t.moments} 条`;
      chip.innerHTML = `#${esc(t.name)}<span class="tag-suggest-count">${t.total}</span>`;
      chip.addEventListener("click", () => {
        addTag(kind, t.name);
        input.value = "";
        render();
      });
      box.appendChild(chip);
    }
    if (items.length > max) {
      const more = document.createElement("span");
      more.className = "tag-suggest-more";
      more.textContent = `还有 ${items.length - max} 个，输入关键词过滤`;
      box.appendChild(more);
    }
  };

  render();
  input.oninput = () => render();
}

/** 添加标签：大小写不敏感去重（复用已有写法），成功返回 true */
function addTag(kind, name) {
  const val = String(name).trim().replace(/^#/, "");
  if (!val) return false;
  const exists = state.tags[kind].some((t) => t.toLowerCase() === val.toLowerCase());
  if (exists) return false;
  // 复用已有标签时保留仓库中的原始写法（如 React 而非 react）
  const known = (state.taxonomies?.tags || []).find((t) => t.name.toLowerCase() === val.toLowerCase());
  state.tags[kind].push(known ? known.name : val);
  drawTags(kind);
  return true;
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
      drawTagSuggestions(kind); // 移除后该标签重新回到候选区
    });
    box.appendChild(chip);
  }
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag(kind, input.value);
      input.value = "";
      drawTagSuggestions(kind); // 已选集合变化，重新过滤候选区
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
    loadTaxonomies(); // 异步预取已有标签/分类（不阻塞渲染，编辑器打开时基本已就绪）
    renderShell();
  })
  .catch(() => renderLogin());

