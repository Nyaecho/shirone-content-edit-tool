/**
 * 标签输入与候选复用 + 分类自绘候选（文章/动态共用）。
 * 交互：手动输入回车添加 / 点击候选 chip 快速复用 / 输入实时过滤。
 */
import { qs, esc } from "./utils.js";
import { api } from "./api-client.js";
import { state } from "./state.js";

/** 拉取仓库聚合的标签/分类（失败静默：候选区不显示即可，不影响手动输入） */
export async function loadTaxonomies() {
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
 */
export function fillCategoryOptions() {
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
 * 绘制"已有标签"候选区：点击即添加；输入实时过滤。
 * kind: "post" | "moment"；当前内容类型的标签优先展示。
 */
export function drawTagSuggestions(kind) {
  const box = qs(kind === "post" ? "#pe-tag-suggest" : "#me-tag-suggest");
  if (!box) return;
  const input = qs(kind === "post" ? "#pe-tags" : "#me-tags");
  const all = state.taxonomies?.tags || [];
  if (!all.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

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
    const max = 30;
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

/** 添加标签：大小写不敏感去重，成功返回 true */
export function addTag(kind, name) {
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

export function drawTags(kind) {
  const box = qs(kind === "post" ? "#pe-tag-box" : "#me-tag-box");
  const input = qs(kind === "post" ? "#pe-tags" : "#me-tags");
  if (!box || !input) return;
  box.innerHTML = "";
  for (const tag of state.tags[kind]) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `#${esc(tag)} <button type="button" title="移除">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      state.tags[kind] = state.tags[kind].filter((t) => t !== tag);
      drawTags(kind);
      drawTagSuggestions(kind);
    });
    box.appendChild(chip);
  }
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag(kind, input.value);
      input.value = "";
      drawTagSuggestions(kind);
    }
  };
}
