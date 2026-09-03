/**
 * Markdown 扩展语法对话框：工具栏按钮 → <dialog> 表单 → 生成规范语法插入光标处。
 * 覆盖：admonition / field-group / collapse-panel / tabs / code-tree / steps /
 *       video(bilibili|youtube|acfun|artplayer) / github-card / image-grid / include。
 * 原则：只生成语法文本，不做实时渲染预览（构建期渲染特性决定预览不真实）。
 */

const dialog = () => document.getElementById("dlg");

/** 通用对话框骨架：<dialog> → { open(title, bodyHTML, onMount), close() } */
function buildDialog() {
  const dlg = dialog();
  return {
    open(title, bodyHTML, onMount) {
      dlg.innerHTML = `
        <div class="dlg-body">
          <h3 class="dlg-title">${title}</h3>
          ${bodyHTML}
          <div class="dlg-actions">
            <button type="button" class="btn btn-ghost" data-cancel>取消</button>
            <button type="button" class="btn btn-primary" data-ok>插入</button>
          </div>
        </div>`;
      dlg.querySelector("[data-cancel]").addEventListener("click", () => dlg.close());
      dlg.querySelector("[data-ok]").addEventListener("click", () => {
        const text = onMount(dlg);
        if (text !== null && text !== undefined) {
          dlg.close();
          insertIntoEditor(text);
        }
      });
      dlg.showModal();
    },
  };
}

/** 当前激活的 EasyMDE 实例（由 app.js 注入） */
let activeEditor = null;
export function setActiveEditor(editor) {
  activeEditor = editor;
}

function insertIntoEditor(text) {
  if (!activeEditor) return;
  const cm = activeEditor.codemirror;
  cm.replaceSelection(`\n${text}\n`);
  cm.focus();
}

// ---------- 表单工具 ----------

function fieldHTML(label, inputHTML, full = false) {
  return `<label class="field${full ? " fr-full" : ""}"><span class="field-label">${label}</span>${inputHTML}</label>`;
}
const textInput = (id, ph = "") => `<input type="text" id="${id}" placeholder="${ph}" />`;
const textArea = (id, ph = "", rows = 4) => `<textarea id="${id}" rows="${rows}" placeholder="${ph}"></textarea>`;
const dlgVal = (id) => document.getElementById(id)?.value.trim() || "";

/** 可重复条目行容器 */
function itemRowHTML(inner, extra = "") {
  return `<div class="item-row">${inner}<button type="button" class="fr-remove" title="删除此条">×</button>${extra}</div>`;
}

function bindAddRow(listId, addBtnId, rowFactory) {
  const list = document.getElementById(listId);
  document.getElementById(addBtnId).addEventListener("click", () => {
    list.appendChild(rowFactory());
    list.lastElementChild.querySelector(".fr-remove").addEventListener("click", (e) => e.target.closest(".item-row").remove());
  });
  // 首行删除按钮
  list.querySelectorAll(".fr-remove").forEach((btn) =>
    btn.addEventListener("click", (e) => e.target.closest(".item-row").remove()),
  );
}

function collectRows(listId) {
  return [...document.getElementById(listId).querySelectorAll(".item-row")];
}

// ---------- 各扩展对话框定义 ----------

const ADMONITION_TYPES = [
  ["note", "📝 便签 Note"],
  ["tip", "💡 技巧 Tip"],
  ["important", "❗ 重要 Important"],
  ["warning", "⚠️ 警告 Warning"],
  ["caution", "🚫 危险 Caution"],
];

export function mountDialogs({ toast }) {
  const dlg = buildDialog();

  const registry = {
    admonition(editor) {
      const options = ADMONITION_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
      dlg.open(
        "提示容器",
        `${fieldHTML("类型", `<select id="ad-type">${options}</select>`)}
         ${fieldHTML("内容", textArea("ad-content", "容器内 Markdown 内容"), true)}`,
        (root) => {
          const type = root.querySelector("#ad-type").value;
          const content = root.querySelector("#ad-content").value;
          if (!content) { toast("内容不能为空", true); return null; }
          return `:::${type}\n${content}\n:::`;
        },
      );
    },

    fieldGroup(editor) {
      const rowHTML = () => itemRowHTML(`
        ${fieldHTML("字段名", `<input type="text" class="fg-name" placeholder="如：timeout" />`)}
        ${fieldHTML("类型 @type", `<input type="text" class="fg-type" placeholder="如：string / boolean / number" />`)}
        ${fieldHTML("默认值 @default（可空）", `<input type="text" class="fg-default" placeholder="如：5000" />`)}
        <div class="field fr-full"><span class="field-label">状态徽标</span>
          <div class="radio-line">
            <label><input type="radio" class="fg-badge" name="fg-badge" value="required" />必填</label>
            <label><input type="radio" class="fg-badge" name="fg-badge" value="optional" checked />可选</label>
            <label><input type="radio" class="fg-badge" name="fg-badge" value="deprecated" />废弃</label>
          </div></div>
        ${fieldHTML("描述（支持 Markdown）", `<textarea class="fg-desc" rows="2" placeholder="字段说明文字"></textarea>`, true)}
      `);
      dlg.open(
        "字段参数卡片（field-group）",
        `<div class="field-rows" id="fg-rows">${rowHTML()}</div>
         <button type="button" class="btn btn-ghost" id="fg-add">＋ 添加字段</button>`,
        (root) => {
          const rows = collectRows("fg-rows");
          const cards = [];
          for (const row of rows) {
            const fname = row.querySelector(".fg-name").value.trim();
            const ftype = row.querySelector(".fg-type").value.trim();
            const fdefault = row.querySelector(".fg-default").value.trim();
            const badge = row.querySelector(".fg-badge:checked")?.value || "optional";
            const fdesc = row.querySelector(".fg-desc").value.trim();
            if (!fname) continue;
            let card = `::: field ${fname}\n`;
            if (ftype) card += `@type ${ftype}\n`;
            if (fdefault) card += `@default \`${fdefault}\`\n`;
            card += `@${badge}\n\n${fdesc}\n:::`;
            cards.push(card);
          }
          if (!cards.length) { toast("至少填写一个字段名", true); return null; }
          return `:::: field-group\n\n${cards.join("\n\n")}\n\n::::`;
        },
      );
      bindAddRow("fg-rows", "fg-add", () => {
        const tpl = document.createElement("template");
        tpl.innerHTML = rowHTML().trim();
        return tpl.content.firstElementChild;
      });
    },

    collapsePanel(editor) {
      dlg.open(
        "折叠面板",
        `${fieldHTML("面板标题", textInput("cp-title", "点击展开查看…"))}
         ${fieldHTML("面板内容", textArea("cp-content", "支持 Markdown / 代码块", 5), true)}`,
        (root) => {
          const title = root.querySelector("#cp-title").value || "详情";
          const content = root.querySelector("#cp-content").value;
          if (!content) { toast("内容不能为空", true); return null; }
          return `:::collapse-panel{title="${title}"}\n${content}\n:::`;
        },
      );
    },

    tabs(editor) {
      const rowHTML = () => itemRowHTML(`
        ${fieldHTML("标签名", textInput("tb-label", "如：JavaScript"))}
        ${fieldHTML("代码语言", textInput("tb-lang", "如：javascript"))}
        ${fieldHTML("代码", textArea("tb-code", "代码内容", 3), true)}
      `);
      dlg.open(
        "代码标签页",
        `<div class="item-rows" id="tb-rows">${rowHTML()}</div>
         <button type="button" class="btn btn-ghost" id="tb-add">＋ 添加标签页</button>`,
        () => {
          const parts = [];
          for (const row of collectRows("tb-rows")) {
            const inputs = row.querySelectorAll("input, textarea");
            const label = inputs[0].value.trim();
            const lang = inputs[1].value.trim() || "text";
            const code = inputs[2].value;
            if (!label) continue;
            parts.push(`== ${label}\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
          }
          if (!parts.length) { toast("至少一个标签页", true); return null; }
          return `:::tabs\n${parts.join("\n")}:::`;
        },
      );
      bindAddRow("tb-rows", "tb-add", () => {
        const tpl = document.createElement("template");
        tpl.innerHTML = rowHTML().trim();
        return tpl.content.firstElementChild;
      });
    },

    codeTree(editor) {
      const rowHTML = () => itemRowHTML(`
        ${fieldHTML("文件名", textInput("ct-file", "如：Button.svelte"))}
        ${fieldHTML("代码语言", textInput("ct-lang", "如：svelte"))}
        ${fieldHTML("代码", textArea("ct-code", "文件内容", 3), true)}
      `);
      dlg.open(
        "交互代码树",
        `<div class="field-row">
           ${fieldHTML("树标题", textInput("ct-title", "如：组件示例"))}
           ${fieldHTML("默认入口文件", textInput("ct-entry", "可选，如：Button.svelte"))}
         </div>
         ${fieldHTML("高度", textInput("ct-height", "可选，如：420px"))}
         <div class="item-rows" id="ct-rows">${rowHTML()}</div>
         <button type="button" class="btn btn-ghost" id="ct-add">＋ 添加文件</button>`,
        (root) => {
          const title = root.querySelector("#ct-title").value || "示例";
          const entry = root.querySelector("#ct-entry").value;
          const height = root.querySelector("#ct-height").value;
          const files = [];
          for (const row of collectRows("ct-rows")) {
            const inputs = row.querySelectorAll("input, textarea");
            const file = inputs[0].value.trim();
            const lang = inputs[1].value.trim() || "text";
            const code = inputs[2].value;
            if (!file) continue;
            files.push(`\`\`\`${lang} title="${file}"\n${code}\n\`\`\`\n`);
          }
          if (!files.length) { toast("至少一个文件", true); return null; }
          let attrs = `title="${title}"`;
          if (height) attrs += ` height="${height}"`;
          if (entry) attrs += ` entry="${entry}"`;
          return `:::code-tree{${attrs}}\n${files.join("\n")}:::`;
        },
      );
      bindAddRow("ct-rows", "ct-add", () => {
        const tpl = document.createElement("template");
        tpl.innerHTML = rowHTML().trim();
        return tpl.content.firstElementChild;
      });
    },

    steps(editor) {
      const rowHTML = () => itemRowHTML(`
        ${fieldHTML("步骤标题", textInput("st-title", "如：安装依赖"))}
        ${fieldHTML("步骤说明", textArea("st-desc", "详细说明（可选）", 2), true)}
      `);
      dlg.open(
        "操作步骤条",
        `<div class="item-rows" id="st-rows">${rowHTML()}</div>
         <button type="button" class="btn btn-ghost" id="st-add">＋ 添加步骤</button>`,
        () => {
          const steps = [];
          for (const row of collectRows("st-rows")) {
            const inputs = row.querySelectorAll("input, textarea");
            const title = inputs[0].value.trim();
            const desc = inputs[1].value.trim();
            if (!title) continue;
            steps.push(desc ? `1. **${title}**\n   ${desc}\n` : `1. **${title}**\n`);
          }
          if (!steps.length) { toast("至少一个步骤", true); return null; }
          return `:::steps\n${steps.join("\n")}:::`;
        },
      );
      bindAddRow("st-rows", "st-add", () => {
        const tpl = document.createElement("template");
        tpl.innerHTML = rowHTML().trim();
        return tpl.content.firstElementChild;
      });
    },

    video(editor) {
      dlg.open(
        "视频嵌入",
        `${fieldHTML("平台", `<select id="vd-platform">
            <option value="bilibili">Bilibili</option>
            <option value="youtube">YouTube</option>
            <option value="acfun">AcFun</option>
            <option value="artplayer">自建直链 (ArtPlayer)</option>
          </select>`)}
         <div class="field-row">
           ${fieldHTML("视频 ID / 直链", textInput("vd-id", "BV号 / 视频ID / ac号 / MP4 地址"))}
           ${fieldHTML("标题", textInput("vd-title", "可选"))}
         </div>
         ${fieldHTML("分 P（仅 Bilibili）", textInput("vd-p", "默认 1"))}`,
        (root) => {
          const platform = root.querySelector("#vd-platform").value;
          const id = root.querySelector("#vd-id").value;
          const title = root.querySelector("#vd-title").value;
          const p = root.querySelector("#vd-p").value;
          if (!id) { toast("请填写视频 ID", true); return null; }
          if (platform === "bilibili") {
            let attrs = `bvid="${id}"`;
            if (title) attrs += ` title="${title}"`;
            if (p && p !== "1") attrs += ` p=${p}`;
            return `::bilibili{${attrs}}`;
          }
          if (platform === "youtube") {
            return `::youtube{id="${id}"${title ? ` title="${title}"` : ""}}`;
          }
          if (platform === "acfun") {
            return `::acfun{acid="${id}"${title ? ` title="${title}"` : ""}}`;
          }
          return `::artplayer{src="${id}"${title ? ` title="${title}"` : ""}}`;
        },
      );
    },

    githubCard(editor) {
      dlg.open(
        "GitHub 仓库卡片",
        fieldHTML("仓库（owner/repo）", textInput("gh-repo", "如：LyraVoid/Shirone")),
        (root) => {
          const repo = root.querySelector("#gh-repo").value;
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast("格式应为 owner/repo", true); return null; }
          return `::github{repo="${repo}"}`;
        },
      );
    },

    imageGrid(editor, { images = [] } = {}) {
      const checkboxes = images.length
        ? images
            .map(
              (img, i) =>
                `<label class="check" style="display:inline-flex;margin:4px 12px 4px 0;">
                   <input type="checkbox" data-ref="${img.repoPath || img.src}" value="${img.webPath || img.src}" />
                   <img src="${img.webPath || img.src}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;" />
                   ${img.name || ""}
                 </label>`,
            )
            .join("")
        : '<p class="field-hint">本文还没有上传图片，请先上传再使用画廊。</p>';
      dlg.open(
        "图片画廊",
        `<div>${checkboxes}</div>
         ${fieldHTML("列数", `<select id="ig-cols"><option>2</option><option>3</option><option>4</option></select>`)}`,
        (root) => {
          const refs = [...root.querySelectorAll("input[data-ref]:checked")].map((cb) => cb.value);
          if (!refs.length) { toast("请勾选图片", true); return null; }
          const cols = root.querySelector("#ig-cols").value;
          return `:::image-grid{columns=${cols}}\n${refs.map((r) => `![${r.split("/").pop()}](${r})`).join("\n")}\n:::`;
        },
      );
    },

    include(editor) {
      dlg.open(
        "Markdown 片段包含",
        `${fieldHTML("片段路径", textInput("in-path", "如：../snippets/common-notice.md"))}
         <div class="field-row">
           ${fieldHTML("行号区间", textInput("in-lines", "可选，如：2-8"))}
           ${fieldHTML("命名区域", textInput("in-region", "可选，如：public-api"))}
         </div>`,
        (root) => {
          const p = root.querySelector("#in-path").value;
          if (!p) { toast("请填写路径", true); return null; }
          const lines = root.querySelector("#in-lines").value;
          const region = root.querySelector("#in-region").value;
          let suffix = "";
          if (region) suffix = `#${region}`;
          else if (lines) suffix = `{${lines}}`;
          return `<!-- @include: ${p}${suffix} -->`;
        },
      );
    },
  };

  // 对话框 onMount 时把 editor 存给 insertIntoEditor 用
  const proxied = {};
  for (const [name, fn] of Object.entries(registry)) {
    proxied[name] = (editor, extra) => {
      setActiveEditor(editor);
      fn(editor, extra);
    };
  }
  return proxied;
}
