/**
 * 自动保存控制器（前端）：debounce 落服务器暂存层 + Ctrl+S 立即保存 + 状态角标。
 *
 * 职责边界：
 * - 只负责「保存到服务器暂存」（PUT /api/drafts/:kind/:id），不推 GitHub
 * - 「暂存/发布」按钮仍走原有 savePost/saveMoment/saveTimelineItem（推 git），
 *   推送成功后端 absorbAfterPush 吸收清暂存
 * - DEV 下载模式：自动保存停用（保存动作本身是下载，无服务器暂存语义）
 *
 * 用法：
 *   const ac = new AutosaveController({ kind, draftId, collect, statusEl, bannerEl });
 *   ac.markDirty();          // 任何输入变更后调用（内部 2s debounce）
 *   await ac.saveNow();      // Ctrl+S / beforeunload 兜底
 *   ac.destroy();            // 编辑器关闭时解绑
 */

const DEBOUNCE_MS = 2000;

export class AutosaveController {
  constructor({ kind, draftId, collect, onRestored }) {
    this.kind = kind;
    this.draftId = draftId; // 可能随 slug 编辑变化：用 getter 函数亦可
    this.collect = collect; // () => ({form, body, images, baseSha})
    this.onRestored = onRestored;
    this.timer = null;
    this.saving = false;
    this.dirty = false;
    this.lastSnapshot = null; // 上次已保存快照（JSON 串），无变化不重存
    this.statusEl = null;
    this.bannerEl = null;
    this._onBeforeUnload = () => {
      if (this.dirty) {
        // 同步兜底：sendBeacon 发快照（不保证成功，尽力而为）
        try {
          const payload = this.collect();
          const body = JSON.stringify({ form: payload.form, body: payload.body, images: payload.images, baseSha: payload.baseSha });
          navigator.sendBeacon(
            `api/drafts/${this.kind}/${encodeURIComponent(this.currentId())}`,
            new Blob([body], { type: "application/json" }),
          );
        } catch { /* 尽力而为 */ }
      }
    };
    window.addEventListener("beforeunload", this._onBeforeUnload);
  }

  /** draftId 允许是 string 或 () => string（新建文章 slug 归一后 id 变化） */
  currentId() {
    return typeof this.draftId === "function" ? this.draftId() : this.draftId;
  }

  bindStatus(statusEl, bannerEl) {
    this.statusEl = statusEl;
    this.bannerEl = bannerEl;
    this.setStatus("", "");
  }

  setStatus(text, cls) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.className = `autosave-status${cls ? ` ${cls}` : ""}`;
  }

  /** 输入变更 → 标脏 + 重置 debounce 计时 */
  markDirty() {
    this.dirty = true;
    this.setStatus("编辑中…", "");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), DEBOUNCE_MS);
  }

  /** 立即保存（Ctrl+S / debounce 到期 / 手动触发）。返回是否成功 */
  async saveNow() {
    clearTimeout(this.timer);
    if (this.saving) return false;
    let payload;
    try {
      payload = this.collect();
    } catch {
      return false; // 表单未就绪（如新建未填 slug）
    }
    const snapshot = JSON.stringify(payload);
    if (!this.dirty && snapshot === this.lastSnapshot) return true; // 无变化
    this.saving = true;
    this.setStatus("保存中…", "saving");
    try {
      const res = await fetch(`api/drafts/${this.kind}/${encodeURIComponent(this.currentId())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: snapshot,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      this.lastSnapshot = snapshot;
      this.dirty = false;
      const t = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      this.setStatus(`已自动保存 ${t}`, "saved");
      return true;
    } catch (err) {
      this.setStatus(`自动保存失败：${err.message}`, "error");
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** 显示「已载入暂存」横幅；onDiscard 由调用方提供（清表单回仓库版或直接关） */
  showBanner(text, onDiscard) {
    if (!this.bannerEl) return;
    this.bannerEl.hidden = false;
    this.bannerEl.innerHTML = "";
    this.bannerEl.append(document.createTextNode(text));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "丢弃暂存";
    btn.addEventListener("click", async () => {
      try {
        await fetch(`api/drafts/${this.kind}/${encodeURIComponent(this.currentId())}`, { method: "DELETE" });
        this.bannerEl.hidden = true;
        this.lastSnapshot = null;
        this.dirty = false;
        this.setStatus("已丢弃暂存，请重新打开", "");
        onDiscard?.();
      } catch {
        this.setStatus("丢弃暂存失败，请重试", "error");
      }
    });
    this.bannerEl.appendChild(btn);
  }

  hideBanner() {
    if (this.bannerEl) this.bannerEl.hidden = true;
  }

  destroy() {
    clearTimeout(this.timer);
    window.removeEventListener("beforeunload", this._onBeforeUnload);
  }
}

/**
 * 打开编辑器时的暂存恢复流程：
 * 1. 拉取服务器暂存 GET /api/drafts/:kind/:id
 * 2. 存在 → 用暂存内容回填表单 + 显示横幅（savedAt 可点击丢弃）
 * 返回暂存快照或 null。
 */
export async function restoreDraft(kind, id) {
  try {
    const res = await fetch(`api/drafts/${kind}/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j?.ok ? j.data : null;
  } catch {
    return null; // 网络失败静默：按无暂存处理
  }
}
