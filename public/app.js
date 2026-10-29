/**
 * shirone-admin 前端应用（vanilla ESM，零构建）——视图层主体。
 * 职责：登录/主框架/三列表/三编辑器；基础设施已拆分至独立模块：
 *   - api-client.js  请求与 toast
 *   - state.js       全局运行时状态
 *   - utils.js       DOM/转义/slug/资源 URL 等纯工具
 *   - tags.js        标签与分类候选
 *   - uploads.js     图片上传链路与封面组件
 *   - pin-bottom.js  卡片钉底控制器
 *   - autosave.js / inline-images.js / ext-preview.js / moods.js（此前已拆）
 */
import { mountDialogs } from "./dialogs.js";
import { AutosaveController, restoreDraft } from "./autosave.js";
import { attachInlineImages } from "./inline-images.js";
import { renderExtendedSyntax } from "./ext-preview.js";
import { MOODS, moodSvg } from "./moods.js";
import { qs, esc, assetUrl, suggestSlug, suggestSuffix, triggerDownload, wrapInline, insertBlock } from "./utils.js";
import { api, toast } from "./api-client.js";
import { state, timelineData } from "./state.js";
import { loadTaxonomies, fillCategoryOptions, drawTagSuggestions, addTag, drawTags } from "./tags.js";
import { handleUploadFiles, drawMomentImages, drawUploadList, setupEditorDrop, setupEditorPaste, renderCoverState, setupCoverUpload } from "./uploads.js";
import { setupCardPinBottom } from "./pin-bottom.js";

// 对话框注册表（启动时挂载）
let DIALOGS = {};

const $app = document.getElementById("app");

// 时间线数据（state.js 的 timelineData：cache + categories，保持本地别名兼容既有代码）
const timelineCache = timelineData.cache;
const timelineCategories = timelineData.categories;

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
// 已拆分至 api-client.js（api / toast）

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

  // 顶栏高度 → CSS 变量：钉顶元素（编辑器工具栏等）的 sticky 偏移要以顶栏底边为准。
  // 顶栏常驻但高度随响应式换行变化（桌面单行 / 手机两行），ResizeObserver 动态跟测。
  const topbar = document.querySelector(".topbar");
  if (topbar) {
    const syncTopbarH = () =>
      document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
    syncTopbarH();
    new ResizeObserver(syncTopbarH).observe(topbar);
  }

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
        deployBtn.textContent = "⇩ 拉取站点";
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
          syncBtn.textContent = "⟳ 同步";
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
let orphanDraftCache = []; // 服务器孤儿暂存草稿（仓库中无对应文章的自动保存快照）

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
    // 仓库文章 + 服务器孤儿暂存草稿（未被仓库吸收的自动保存快照）一起列出，
    // 避免新建文章返回后自动保存内容在主页「消失」
    const [posts, drafts] = await Promise.all([
      api("/posts"),
      state.devMode ? Promise.resolve([]) : api("/drafts").then((d) => d.post || []).catch(() => []),
    ]);
    postsCache = posts;
    orphanDraftCache = drafts.filter((d) => !posts.some((p) => p.slug === d.id));
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
  const draftItems = orphanDraftCache.filter((d) => {
    if (hideDraft && d.draftFlag) return false;
    if (!q) return true;
    return [d.title, d.id].join(" ").toLowerCase().includes(q);
  });

  if (!items.length && !draftItems.length) {
    listEl.innerHTML = `<div class="empty">没有符合条件的文章</div>`;
    return;
  }
  listEl.innerHTML = "";
  for (const d of draftItems) {
    const card = document.createElement("div");
    card.className = "content-card";
    const at = new Date(d.savedAt);
    const meta = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} 自动保存`;
    card.innerHTML = `
      <div class="cc-main">
        <div class="cc-title">${esc(d.title || d.id)}
          <span class="badge badge-staged">未发布暂存</span>
          ${d.draftFlag ? '<span class="badge badge-draft">草稿</span>' : ""}
        </div>
        <div class="cc-sub">${esc(d.id)} · ${d.bodyLength} 字</div>
      </div>
      <div class="cc-meta">${esc(meta)}<button type="button" class="cc-discard" title="丢弃此暂存（不影响仓库文章）" aria-label="丢弃此暂存"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7h15"/><path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 11.1a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/><path d="M10 11v5.5M14 11v5.5"/></svg></button></div>`;
    card.addEventListener("click", () => openPostEditor(d.id));
    card.querySelector(".cc-discard").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`丢弃暂存「${d.title || d.id}」？此操作不可恢复。`)) return;
      try {
        await api(`/drafts/post/${encodeURIComponent(d.id)}`, { method: "DELETE" });
        toast("暂存已丢弃");
        orphanDraftCache = orphanDraftCache.filter((x) => x.id !== d.id);
        drawPosts();
      } catch (err) {
        toast(err.message, true);
      }
    });
    listEl.appendChild(card);
  }
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

  // slug 可能来自列表页的孤儿暂存草稿入口：仓库无此文章 → 按新建语义打开，
  // 但预填 slug 让编辑器与暂存快照同键（否则 tempKey 不同，恢复/吸收都错位）
  let post = null;
  if (slug) {
    post = await api(`/posts/${encodeURIComponent(slug)}`).catch((err) => {
      if (err.message?.includes("不存在")) return null; // 仓库无文件（孤儿暂存入口）
      throw err;
    });
  }
  const isNew = !post;
  if (!post) post = { slug: slug || "", path: "", sha: null, frontmatter: {}, body: "", images: [], referencedImages: [] };
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
          // 契约：AutosaveController 期望 {form, body, images, baseSha}——form 必须包一层。
          // （历史 bug：曾把表单字段展平在顶层，服务端解构 form=undefined 存成 {}，
          //  恢复时标题/分类/草稿勾选全部丢失）
          return { form: collectPostForm(), body: state.editors.post.value(), images: imgs, baseSha: post.sha };
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
        className: "fa fa-magic", // FA4 无 fa-highlighter（FA5 名），用魔法棒替代
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
        className: "fa fa-sitemap", // FA4 无 fa-project-diagram（FA5 名），用站点地图替代
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

  // 预览入口显眼化：给预览/分屏按钮追加文字标签（纯图标难以发现）
  for (const [key, text] of [["preview", "预览"], ["side-by-side", "分屏"]]) {
    const btn = mde.toolbarElements?.[key];
    if (btn && !btn.querySelector(".tb-text")) {
      const label = document.createElement("span");
      label.className = "tb-text";
      label.textContent = text;
      btn.appendChild(label);
    }
  }

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
    // 版本对比（乐观锁语义）：暂存记录保存时的文件 sha 与当前一致才恢复。
    // 修复：老文章无 updatedAt/publishedAt 时旧时间比较恒真，空暂存覆盖标题/分类/草稿勾选。
    // 例外：新建文章（仓库无文件）双方 sha 均为 null——此时暂存必然是唯一内容，放行恢复，
    // 否则新建后返回、再从列表打开暂存草稿时内容找不回
    const snapIsCurrent = snap
      && (snap.baseSha != null ? snap.baseSha === post.sha : post.sha == null);
    if (snapIsCurrent) {
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

// 心情清单与 SVG 图标见 moods.js（UI 用内联 SVG；frontmatter 存 iconify 名）

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

  // 心情选择（内联 SVG 表情，hover 提示文字；选中存 iconify 名）
  const moodRow = qs("#me-moods");
  moodRow.innerHTML = "";
  for (const m of MOODS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mood-btn";
    btn.title = m.label;
    btn.setAttribute("aria-label", m.label);
    btn.appendChild(moodSvg(m));
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
    // 孤儿暂存草稿：仓库无对应文章（404），删除动作降级为丢弃暂存
    if (kind === "post" && !state.devMode && err.message?.includes("不存在")) {
      try {
        await api(`/drafts/post/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("暂存已丢弃");
        renderPostsList();
        return;
      } catch {
        /* 丢弃失败走原始错误提示 */
      }
    }
    toast(err.message, true);
  }
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

