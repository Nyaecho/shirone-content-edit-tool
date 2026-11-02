/**
 * 主题扩展语法近似预览：在 marked 渲染前把 Shirone 扩展语法转成带样式的 HTML。
 *
 * 定位是「近似」——不追求与 Astro 构建产物像素一致，只保证：
 * - 扩展语法不显示为原始 ::: 文本
 * - 图片/结构/颜色语义与站点风格接近
 *
 * 覆盖语法（与 dialogs.js 生成端互逆，均对齐主题仓 manifest 正统）：
 * - :::tip / info / note / important / warning / caution / details 容器（含标题）
 * - :::grid{columns="N"} 图片画廊（历史 :::image-grid 已废弃，走未知容器兜底）
 * - ::: collapse 无序列表折叠面板（每项 `- 标题` + 缩进正文；历史 :::collapse-panel 已废弃）
 * - :::steps 步骤条（有序列表项，粗体作标题）
 * - ::: tabs + @tab 标签 行标签页
 * - :::code-tree 代码树（近似缩进树）
 * - :::field-group 字段参数卡片
 * - :::github-card GitHub 仓库卡片（外链近似）
 * - 视频 :::video 或 <Video /> 语法保留原始标记（近似提示框）
 * - ==高亮==、:spoiler[文本]
 */
import { esc } from "./utils.js";

// marked 渲染器注入点：把扩展语法转为 HTML 块，剩余交给 marked
export function renderExtendedSyntax(src) {
  let text = String(src || "");

  // 1) fenced 容器（:::xxx ... :::）需要跨行处理——逐块扫描
  text = transformContainers(text);

  // 2) 行内扩展
  text = text
    .replace(/==([^=\n]+)==/g, '<mark class="ext-highlight">$1</mark>')
    .replace(/:spoiler\[([^\]]*)\]/g, '<span class="ext-spoiler">$1</span>');

  return text;
}

function transformContainers(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // 容器名前允许空格（主题正统 tabs 为 `::: tabs[#id]` 形态）；
    // 名后允许空格标志词（collapse 正统的 accordion/expand），并入属性串供 attrValue/hasFlag 判定
    const open = line.match(/^(:{3,})\s*([\w-]+)?(\{[^}]*\})?((?:\s+[\w-]+)*)\s*$/);
    if (!open) {
      out.push(line);
      i++;
      continue;
    }
    const fence = open[1];
    const kind = (open[2] || "").toLowerCase();
    const attrs = `${open[3] || ""} ${open[4] || ""}`.trim();

    // 找匹配的关闭 fence（同长度以上）
    let j = i + 1;
    let body = [];
    let closed = false;
    while (j < lines.length) {
      if (new RegExp(`^${fence}:*\\s*$`).test(lines[j])) {
        closed = true;
        break;
      }
      body.push(lines[j]);
      j++;
    }
    if (!closed) {
      // 未闭合：按原样输出（避免吞掉正文）
      out.push(line);
      i++;
      continue;
    }
    out.push(renderContainer(kind, attrs, body.join("\n")));
    i = j + 1;
  }
  return out.join("\n");
}

function attrValue(attrs, key) {
  const m = attrs.match(new RegExp(`${key}\\s*=\\s*["']?([^"'\\s}\\]]+)`));
  return m ? m[1] : null;
}

/** 裸标志词判定（主题 collapse 的 `::: collapse accordion` 空格词形态，与 key=value 等价） */
function hasFlag(attrs, key) {
  return new RegExp(`(?:^|\\s)${key}(?=\\s|$)`).test(attrs);
}

function renderContainer(kind, attrs, body) {
  // 内部可能嵌套 markdown：交给调用方的 markdown 二次渲染（renderExtended 的输出会过 marked）
  switch (kind) {
    case "tip":
    case "info":
    case "note":
    case "important":
    case "warning":
    case "caution":
    case "details":
    case "danger": {
      // 类型集合对齐主题 remark-admonitions（7 类）；danger 为历史兼容保留
      const titles = { tip: "提示", info: "信息", note: "备注", important: "重要", warning: "警告", caution: "注意", details: "详情", danger: "危险" };
      const title = attrValue(attrs, "title") || titles[kind] || kind;
      return `<div class="ext-admonition ext-${kind}"><p class="ext-adm-title">${esc(title)}</p>\n${body}\n</div>`;
    }
    case "grid": {
      // 主题正统：容器名 grid（rehype-component-image-grid 只认 :::grid）；历史 :::image-grid 已废弃
      const cols = attrValue(attrs, "columns") || 3;
      const imgs = [...body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)]
        .map((m) => `<figure><img src="${esc(m[2])}" alt="${esc(m[1])}" loading="lazy" /></figure>`)
        .join("");
      return `<div class="ext-image-grid" style="--ext-cols:${esc(cols)}">${imgs}</div>`;
    }
    case "collapse": {
      // 主题正统（rehype-collapse-panels）：容器内一个无序列表，每项 = `- 标题` 行 +
      // 缩进正文；accordion/expand 为空格标志词或 key=value；`:+`/`:-` 行首标记
      // 控制展开/收起（open 判定与主题 renderItem 一一对应）。
      // 历史 :::collapse-panel 已废弃，不再特判（走未知容器兜底）
      const accordion = hasFlag(attrs, "accordion") || attrValue(attrs, "accordion") === "true";
      const expand = hasFlag(attrs, "expand") || attrValue(attrs, "expand") === "true";
      const panels = [];
      for (const line of body.split("\n")) {
        const item = line.match(/^\s*-\s+(.+)$/);
        if (item) {
          const raw = item[1];
          const marker = raw.match(/^:([+-])(?:[\t ]+|$)/)?.[1] || null;
          const titleText = raw.replace(/^:([+-])(?:[\t ]+|$)/, "").trim();
          panels.push({ title: titleText || "折叠面板", body: [], marker });
        } else if (panels.length && line.trim()) {
          panels[panels.length - 1].body.push(line.replace(/^ {2}/, ""));
        }
      }
      if (!panels.length) return `<div class="ext-unknown"><p class="ext-adm-title">扩展容器：collapse</p>\n${body}\n</div>`;
      const markedIdx = panels.findIndex((p) => p.marker === "+");
      return panels
        .map((p, idx) => {
          const open = accordion
            ? idx === (markedIdx >= 0 ? markedIdx : expand ? 0 : -1)
            : p.marker === "+" || (expand && p.marker !== "-");
          return `<details class="ext-collapse"${open ? " open" : ""}><summary>${esc(p.title)}</summary>\n${p.body.join("\n")}\n</details>`;
        })
        .join("\n");
    }
    case "steps": {
      // 按有序列表项（`1.` / `1)` 行）拆分；项内粗体作标题（dialogs 生成 `1. **标题**`+缩进描述）
      const parts = body.split(/(?=^\s*\d+[.)]\s)/m).filter((p) => p.trim());
      const items = parts
        .map((p) => {
          const firstLine = p.match(/^\s*\d+[.)]\s+(.+)$/m);
          const bm = firstLine?.[1]?.match(/\*\*(.+?)\*\*/);
          const title = bm ? bm[1] : firstLine?.[1]?.replace(/\*\*/g, "") || "步骤";
          const content = p.replace(/^\s*\d+[.)]\s+.+\n?/m, "").trim();
          return `<li><p class="ext-step-title">${esc(title)}</p>\n${content}\n</li>`;
        })
        .join("");
      return `<ol class="ext-steps">${items}</ol>`;
    }
    case "tabs": {
      // 主题正统 @tab 行分标签（对齐 dialogs.js 生成端与主题 rehype-option-groups）
      const tabs = [...body.matchAll(/^@tab(?::active)?\s+(.+?)\s*(?:#([\w-]+))?\s*$/gm)];
      if (!tabs.length) return `<div class="ext-tabs-raw"><pre>${esc(body)}</pre></div>`;
      let html = '<div class="ext-tabs">';
      tabs.forEach((m, idx) => {
        const start = m.index + m[0].length;
        const end = idx + 1 < tabs.length ? tabs[idx + 1].index : body.length;
        const content = body.slice(start, end).trim();
        html += `<div class="ext-tab"><p class="ext-tab-label">${esc(m[1])}</p>\n${content}\n</div>`;
      });
      html += "</div>";
      return html;
    }
    case "code-tree": {
      return `<div class="ext-code-tree"><pre>${esc(body)}</pre></div>`;
    }
    case "field-group": {
      return `<div class="ext-field-group">\n${body}\n</div>`;
    }
    case "github-card": {
      const repo = attrValue(attrs, "repo") || body.trim();
      return `<a class="ext-github-card" href="https://github.com/${esc(repo)}" target="_blank" rel="noopener"><i class="fa fa-github"></i> ${esc(repo)}</a>`;
    }
    default:
      // 未知容器：保留标记但加样式提示，避免裸 ::: 文本
      return `<div class="ext-unknown"><p class="ext-adm-title">扩展容器：${esc(kind || "未命名")}</p>\n${body}\n</div>`;
  }
}
