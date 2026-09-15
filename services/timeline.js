/**
 * 时间线（timeline）业务服务。
 * 与文章/动态不同：所有节点存于内容仓同一个文件 data/timeline.ts
 * （`export const timelineData: TimelineItem[] = [...]`，纯数据字面量）。
 * 读取 = 提取数组字面量求值；保存 = 定位目标节点后整文件确定性序列化写回。
 * 并发策略：保存时服务端重读最新文件，按「打开时快照 + 下标」定位目标节点，
 * 不匹配即 409，天然保留其他节点的外部修改。
 */
import * as store from "../lib/store.js";
import YAML from "yaml";

const TIMELINE_PATH = "data/timeline.ts";
const TIMELINE_CONFIG_PATH = "config/timeline.yaml";

/** 输出字段顺序（与 TimelineItem 接口声明一致；enable 仅在 false 时写入） */
const FIELD_ORDER = [
  "title",
  "date",
  "category",
  "subtitle",
  "location",
  "description",
  "highlights",
  "tags",
  "links",
  "icon",
  "featured",
  "enable",
];

/** links 条目字段顺序 */
const LINK_FIELD_ORDER = ["label", "url", "icon"];

/** 声明行：export const timelineData<Types> = */
const DECL_RE = /export\s+const\s+timelineData\b[^=]*=\s*/;

// ---------- 解析 ----------

/**
 * 读取并解析 data/timeline.ts。
 * @returns {{ path: string, sha: string, items: object[], prefix: string, suffix: string }}
 *   prefix/suffix 保留声明之前的文件头（注释、接口定义）与数组之后的收尾（`;` 及换行）
 */
export async function parseTimelineFile() {
  const file = await store.getFile(TIMELINE_PATH);
  if (!file) {
    const err = new Error(`内容仓缺少 ${TIMELINE_PATH}，请先按 Shirone-Content 模板创建`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const src = file.contentRaw;
  const decl = DECL_RE.exec(src);
  if (!decl) {
    const err = new Error(`${TIMELINE_PATH} 中未找到 "export const timelineData = [...]" 声明`);
    err.code = "PARSE_ERROR";
    err.status = 422;
    throw err;
  }
  const open = decl.index + decl[0].length;
  if (src[open] !== "[") {
    const err = new Error(`${TIMELINE_PATH} 的 timelineData 不是数组字面量`);
    err.code = "PARSE_ERROR";
    err.status = 422;
    throw err;
  }
  const { literal, end } = extractArrayLiteral(src, open);
  let items;
  try {
    // 自有私有内容仓的纯数据字面量，无不可信输入，可安全求值
    items = new Function(`"use strict"; return (${literal});`)();
  } catch (e) {
    const err = new Error(`${TIMELINE_PATH} 数组解析失败：${e.message}（文件可能含 TS 类型标注等非字面量语法）`);
    err.code = "PARSE_ERROR";
    err.status = 422;
    throw err;
  }
  if (!Array.isArray(items)) {
    const err = new Error(`${TIMELINE_PATH} 的 timelineData 求值结果不是数组`);
    err.code = "PARSE_ERROR";
    err.status = 422;
    throw err;
  }
  return { path: TIMELINE_PATH, sha: file.sha, items, prefix: src.slice(0, open), suffix: src.slice(end) };
}

/** 从 open（指向 `[`）起做括号深度扫描，返回数组字面量及其闭括号后一位的下标 */
function extractArrayLiteral(src, open) {
  let depth = 0;
  let str = null; // 当前所在字符串引号：'"' | "'" | "`"
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (c === "\\") i += 1; // 跳过转义字符
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      str = c;
      continue;
    }
    if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return { literal: src.slice(open, i + 1), end: i + 1 };
    }
  }
  const err = new Error(`${TIMELINE_PATH} 数组字面量未闭合`);
  err.code = "PARSE_ERROR";
  err.status = 422;
  throw err;
}

// ---------- 序列化（biome 风格：tab 缩进、双引号、尾逗号、中文不转义） ----------

/** 全角字符判断（CJK 标点/文字、全角 ASCII、假名等；East_Asian_Width F/W） */
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2329-\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** 计算字符串的显示宽度（biome 列宽语义：全角字符按 2 列计） */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    w += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  }
  return w;
}

/** 序列化值；level 为当前值所在行的缩进层级（tab 数） */
function serializeValue(value, level) {
  const indent = "\t".repeat(level);
  if (Array.isArray(value)) {
    // 短的基本类型数组保持单行（对齐 biome ≤80 列不换行的行为，减少 diff 噪音）
    // biome 的 tab 显示宽度为 2，列宽按 Unicode 宽度计算（CJK 字符 2 列）
    if (value.every((v) => v == null || typeof v !== "object")) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (indent.length * 2 + displayWidth(inline) + 8 <= 80) return inline; // +8 预留 "key: " 与尾逗号
    }
    if (!value.length) return "[]";
    const inner = value
      .map((v) => `${indent}\t${serializeValue(v, level + 1)},`)
      .join("\n");
    return `[\n${inner}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const inner = Object.entries(value)
      .map(([k, v]) => `${indent}\t${k}: ${serializeValue(v, level + 1)},`)
      .join("\n");
    return `{\n${inner}\n${indent}}`;
  }
  return JSON.stringify(value); // 字符串/布尔/数字
}

/** 将节点数组序列化为多行字面量（不含外层括号前的 `= ` 与之后的 `;`） */
function serializeTimeline(items) {
  if (!items.length) return "[]";
  const parts = items.map((item) => {
    const fields = Object.entries(item).map(
      ([k, v]) => `\t\t${k}: ${serializeValue(v, 2)},`,
    );
    return `\t{\n${fields.join("\n")}\n\t}`;
  });
  return `[\n${parts.join(",\n")},\n]`;
}

// ---------- 读取 ----------

/** 列表 + 分类（分类来自 config/timeline.yaml，仅读） */
export async function listTimeline() {
  const parsed = await parseTimelineFile();
  return { items: parsed.items, categories: await getCategories() };
}

/** 解析 config/timeline.yaml 的分类清单；文件缺失/解析失败时返回 []（不阻塞编辑） */
export async function getCategories() {
  try {
    const file = await store.getFile(TIMELINE_CONFIG_PATH);
    if (!file) return [];
    const doc = YAML.parse(file.contentRaw);
    return Array.isArray(doc?.categories) ? doc.categories : [];
  } catch {
    return [];
  }
}

// ---------- 变更（create / update / delete） ----------

/**
 * 变更时间线节点：保存时重读最新文件 → 定位目标节点 → 整文件写回。
 * @param {"create"|"update"|"delete"} op
 * @param {{ index?: number, original?: object|null, item?: object|null }} payload
 */
export async function mutateTimeline(op, { index, original, item } = {}) {
  const parsed = await parseTimelineFile();
  const items = parsed.items;

  if (op === "create") {
    const clean = await validateAndNormalize(item);
    items.push(clean);
    return commit(parsed, items, `feat(timeline): 新增节点 ${clean.title}`);
  }

  const idx = locateItem(items, index, original);
  if (op === "update") {
    const clean = await validateAndNormalize(item);
    items[idx] = clean;
    return commit(parsed, items, `edit(timeline): 更新节点 ${clean.title}`);
  }
  if (op === "delete") {
    const removed = items[idx];
    items.splice(idx, 1);
    return commit(parsed, items, `chore(timeline): 删除节点 ${removed?.title || ""}`);
  }
  const err = new Error("op 必须为 create / update / delete");
  err.status = 400;
  throw err;
}

/** 定位目标节点：先按下标校验快照一致，失败则全局搜索快照，均未命中返回 409 */
function locateItem(items, index, original) {
  const conflict = () => {
    const err = new Error("该节点已被其他修改变更，请返回列表刷新后重试");
    err.code = "CONFLICT";
    return err;
  };
  if (!Number.isInteger(index) || index < 0 || index >= items.length || original == null) {
    throw conflict();
  }
  if (deepEqual(items[index], original)) return index;
  const found = items.findIndex((it) => deepEqual(it, original));
  if (found >= 0) return found;
  throw conflict();
}

/** 整文件写回（DEV 模式由 store 转为下载响应） */
async function commit(parsed, items, message) {
  // 序列化固定产出 \n；写回前统一为原文件的行尾风格（CRLF/LF），避免混行尾
  const raw = parsed.prefix + serializeTimeline(items) + parsed.suffix;
  const normalized = parsed.prefix.includes("\r\n")
    ? raw.replace(/\r?\n/g, "\r\n")
    : raw.replace(/\r\n/g, "\n");
  const result = await store.putFile(TIMELINE_PATH, normalized, message, parsed.sha);
  return { path: TIMELINE_PATH, raw: normalized, ...result };
}

// ---------- 校验与规整 ----------

/** 校验并规整为规范字段顺序/类型的节点对象；非法时抛 400 */
async function validateAndNormalize(input) {
  const item = input || {};
  const errors = [];
  const title = String(item.title ?? "").trim();
  const date = String(item.date ?? "").trim();
  if (!title) errors.push("标题不能为空");
  if (!date) errors.push("日期不能为空");

  const category = String(item.category ?? "").trim();
  if (category) {
    const categories = await getCategories();
    // yaml 缺失时不强校验分类（避免阻塞编辑）
    if (categories.length && !categories.some((c) => c && c.key === category)) {
      errors.push(`分类 "${category}" 不在 config/timeline.yaml 的分类清单中`);
    }
  }

  const links = [];
  if (Array.isArray(item.links)) {
    item.links.forEach((l, i) => {
      const label = String(l?.label ?? "").trim();
      const url = String(l?.url ?? "").trim();
      if (!label && !url) return; // 全空条目静默丢弃
      if (!label) errors.push(`第 ${i + 1} 条关联链接缺少名称`);
      if (!/^https?:\/\//.test(url)) errors.push(`第 ${i + 1} 条关联链接的 URL 需以 http(s):// 开头`);
      const link = { label, url };
      const icon = String(l?.icon ?? "").trim();
      if (icon) link.icon = icon;
      links.push(link);
    });
  }
  if (errors.length) {
    const err = new Error(errors.join("；"));
    err.status = 400;
    throw err;
  }

  const out = { title, date };
  if (category) out.category = category;
  for (const key of ["subtitle", "location", "description"]) {
    const v = String(item[key] ?? "").trim();
    if (v) out[key] = v;
  }
  for (const key of ["highlights", "tags"]) {
    const arr = Array.isArray(item[key])
      ? item[key].map((s) => String(s ?? "").trim()).filter(Boolean)
      : [];
    if (arr.length) out[key] = arr;
  }
  if (links.length) out.links = links;
  // icon 按接口声明顺序排在 links 之后、featured 之前
  const icon = String(item.icon ?? "").trim();
  if (icon) out.icon = icon;
  if (item.featured === true) out.featured = true;
  if (item.enable === false) out.enable = false;
  return out;
}

/** 深比较（忽略对象键序，用于快照定位） */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
