/**
 * 主题扩展语法近似预览：在 marked 渲染前把 Shirone 扩展语法转成带样式的 HTML。
 *
 * 定位是「近似」——不追求与 Astro 构建产物像素一致，只保证：
 * - 扩展语法不显示为原始 ::: 文本
 * - 图片/结构/颜色语义与站点风格接近
 *
 * 覆盖语法（与 dialogs.js 生成端互逆）：
 * - :::tip / info / warning / danger / note 容器（含标题）
 * - :::image-grid{columns=N} 图片画廊
 * - :::collapse-panel 折叠面板（:::summary 标题行）
 * - :::steps 步骤条
 * - :::tabs + ===="标签" 标签页
 * - :::code-tree 代码树（近似缩进树）
 * - :::field-group 字段参数卡片
 * - :::github-card GitHub 仓库卡片（外链近似）
 * - 视频 :::video 或 <Video /> 语法保留原始标记（近似提示框）
 * - ==高亮==、:spoiler[文本]
 */

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
    const open = line.match(/^(:{3,})([\w-]+)?(\{[^}]*\})?\s*$/);
    if (!open) {
      out.push(line);
      i++;
      continue;
    }
    const fence = open[1];
    const kind = (open[2] || "").toLowerCase();
    const attrs = open[3] || "";

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

function renderContainer(kind, attrs, body) {
  // 内部可能嵌套 markdown：交给调用方的 markdown 二次渲染（renderExtended 的输出会过 marked）
  switch (kind) {
    case "tip":
    case "info":
    case "note":
    case "warning":
    case "danger": {
      const titles = { tip: "提示", info: "信息", note: "备注", warning: "警告", danger: "危险" };
      const title = attrValue(attrs, "title") || titles[kind] || kind;
      return `<div class="ext-admonition ext-${kind}"><p class="ext-adm-title">${esc(title)}</p>\n${body}\n</div>`;
    }
    case "image-grid": {
      const cols = attrValue(attrs, "columns") || 3;
      const imgs = [...body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)]
        .map((m) => `<figure><img src="${esc(m[2])}" alt="${esc(m[1])}" loading="lazy" /></figure>`)
        .join("");
      return `<div class="ext-image-grid" style="--ext-cols:${esc(cols)}">${imgs}</div>`;
    }
    case "collapse-panel": {
      // :::summary 标题行 + 其余内容
      const m = body.match(/^:::summary\s*(.+?)\s*$/m);
      const title = m ? m[1] : "折叠内容";
      const rest = m ? body.replace(/^:::summary\s*.+\s*$/m, "") : body;
      return `<details class="ext-collapse"><summary>${esc(title)}</summary>\n${rest}\n</details>`;
    }
    case "steps": {
      // 步骤以 ### 标题或 **加粗** 行分界；近似按标题拆
      const parts = body.split(/\n(?=###?\s)/).filter(Boolean);
      const items = parts
        .map((p) => {
          const hm = p.match(/^###?\s*(.+)$/m);
          const title = hm ? hm[1] : "步骤";
          const content = hm ? p.replace(/^###?\s*.+$\n?/m, "") : p;
          return `<li><p class="ext-step-title">${title}</p>\n${content}\n</li>`;
        })
        .join("");
      return `<ol class="ext-steps">${items}</ol>`;
    }
    case "tabs": {
      const tabs = [...body.matchAll(/^====\s*"([^"]+)"\s*$/gm)];
      if (!tabs.length) return `<div class="ext-tabs-raw"><pre>${esc(body)}</pre></div>`;
      let html = '<div class="ext-tabs">';
      let last = 0;
      tabs.forEach((m, idx) => {
        const start = m.index + m[0].length;
        const end = idx + 1 < tabs.length ? tabs[idx + 1].index : body.length;
        const content = body.slice(start, end).trim();
        html += `<div class="ext-tab"><p class="ext-tab-label">${esc(m[1])}</p>\n${content}\n</div>`;
        last = end;
      });
      html += "</div>";
      void last;
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
