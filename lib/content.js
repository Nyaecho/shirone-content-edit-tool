/**
 * 格式核心：frontmatter 生成/解析/合并、时间注入、slug 校验、路径计算。
 * 所有 Shirone 内容格式规则都集中在本文件。
 *
 * 时间语义（依据主题源码 src/utils/content-date.ts）：
 * - naive（无偏移）时间字符串被主题按 UTC 解析，展示时换算到站点时区
 * - 构建期校验：publishedAt 在站点时区的日历日期必须 === published（published 按 UTC 字段取日期）
 * - 因此注入规则：publishedAt = naive UTC 时刻字符串；published = 该时刻在站点时区的日历日期
 */
import matter from "gray-matter";
import YAML from "yaml";

// ---------- YAML 序列化 ----------

/**
 * 时间值形态：纯日期 "2026-09-04" 或日期时间 "2026-09-04 05:50:13"
 * （兼容 ISO 变体：T 分隔、毫秒、Z 后缀——用于规范化历史数据）。
 * 全链路统一约定：admin 内部时间值一律为 naive 字符串，无引号写出——
 * Astro 内容层（gray-matter，YAML 1.1）才会解析成 Date 过 z.date() 校验。
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:\.\d+)?Z?$/;

const yamlOptions = {
  // 普通字符串：加引号防特殊字符歧义；日期时间：序列化后剥引号（见 stringifyFrontmatter）
  defaultStringType: "QUOTE_DOUBLE",
  defaultKeyType: "PLAIN",
  lineWidth: 0,
  minContentWidth: 0,
};

/**
 * 将 frontmatter 对象序列化为 YAML 文本。
 *
 * 时间字段统一策略（全链路单一约定）：
 * 1. 读入端（parseMarkdown）已把 Date/ISO 字符串规范化为 naive 字符串
 *    "YYYY-MM-DD HH:mm:ss" 或 "YYYY-MM-DD"；
 * 2. 序列化时 yaml 库对普通字符串加双引号，后处理按行匹配剥引号——
 *    Astro（gray-matter，YAML 1.1）才能把无引号时间戳解析成 Date 过 z.date()。
 * 正则兼容 ISO 变体（T 分隔/毫秒/Z 后缀），兜住未经规范化的历史数据。
 */
export function stringifyFrontmatter(data) {
  const raw = YAML.stringify(data, yamlOptions);
  return raw
    .split("\n")
    .map((line) =>
      line.replace(
        /^(\s*)([A-Za-z0-9_-]+): "(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:\.\d+)?Z?)"$/,
        "$1$2: $3",
      ),
    )
    .join("\n");
}

/**
 * 解析 Markdown 原文 → { data, body }。
 * 读入的时间字段统一规范化为 naive 字符串：
 * - gray-matter 会把无引号时间戳解析成 Date → 统一转回 "YYYY-MM-DD[ HH:mm:ss]"
 * - 历史 ISO 字符串（"2026-09-04T06:29:46.000Z"）也一并归一
 * 这样读-写回路不再产生格式漂移，序列化出口只有一种形态。
 */
export function parseMarkdown(raw) {
  const parsed = matter(raw);
  return {
    data: normalizeTimeFields(parsed.data),
    body: parsed.content.replace(/^\r?\n/, ""),
  };
}

/** 递归把对象里所有时间字段（Date / ISO 串）规范化为 naive 字符串 */
function normalizeTimeFields(data) {
  if (!data || typeof data !== "object") return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Date) {
      out[k] = naiveFromUtc(v);
    } else if (typeof v === "string" && NAIVE_DATETIME.test(v)) {
      out[k] = v.replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "");
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Date（UTC 口径）→ naive 字符串（与 naiveUtcString 同格式） */
function naiveFromUtc(d) {
  return (
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ` +
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`
  );
}

/** 组装完整 Markdown 文件内容 */
export function buildMarkdown(data, body) {
  return `---\n${stringifyFrontmatter(data)}---\n\n${body.trimStart()}`;
}

// ---------- 时间注入 ----------

/**
 * 当前 UTC 时刻 → naive 字符串 "YYYY-MM-DD HH:mm:ss"
 */
export function naiveUtcString(date = new Date()) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * 时刻在指定 IANA 时区的日历日期 "YYYY-MM-DD"
 * 与主题 getDateParts 相同口径（Intl en-CA）。
 */
export function calendarDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const v = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * 新文章时间注入：返回 { published, publishedAt }
 * - publishedAt：当前时刻的 naive UTC 字符串
 * - published：该时刻在站点时区的日历日期（保证构建期同日校验恒过）
 */
export function injectPublishedTime(timeZone) {
  const now = new Date();
  return {
    publishedAt: naiveUtcString(now),
    published: calendarDateInTimeZone(now, timeZone),
  };
}

/**
 * "刷新更新时间"注入：返回 { updated, updatedAt }
 * updatedAt 不能脱离 updated 单独存在，两者必须成对生成。
 */
export function injectUpdatedTime(timeZone, date = new Date()) {
  return {
    updatedAt: naiveUtcString(date),
    updated: calendarDateInTimeZone(date, timeZone),
  };
}

// ---------- slug 与路径 ----------

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 校验 slug：强制小写 ASCII + 连字符，中文必须放在 title 字段 */
export function validateSlug(slug) {
  if (!slug || typeof slug !== "string") {
    return "slug 不能为空";
  }
  if (slug.length > 80) {
    return "slug 过长（最多 80 字符）";
  }
  if (!SLUG_RE.test(slug)) {
    return "slug 只能包含小写字母、数字和连字符（不能以连字符开头或结尾），中文请写在标题字段";
  }
  return null;
}

const RESERVED_SLUGS = new Set(["about", "archive", "archives", "friends", "moments", "tags", "categories", "posts", "api", "admin"]);

export function isReservedSlug(slug) {
  return RESERVED_SLUGS.has(slug);
}

/** 文章主文件在内容仓中的路径（文件夹式：content/posts/<slug>/index.md） */
export function postFilePath(slug) {
  return `content/posts/${slug}/index.md`;
}

/** 动态文件路径：content/moments/YYYY-MM-DD-描述.md */
export function momentFilePath(published, suffix = "") {
  const day = typeof published === "string" ? published.slice(0, 10) : published.toISOString().slice(0, 10);
  const name = suffix ? `${day}-${suffix}` : day;
  return `content/moments/${name}.md`;
}

/** 文章同目录图片路径 */
export function postAssetPath(slug, filename) {
  return `content/posts/${slug}/${filename}`;
}

/** 动态图片路径：public/images/albums/<日期slug>/<文件名> */
export function momentAssetPath(published, filename) {
  const day = typeof published === "string" ? published.slice(0, 10) : published.toISOString().slice(0, 10);
  return `public/images/albums/${day}/${filename}`;
}

// ---------- frontmatter 合并策略 ----------

/**
 * 合并编辑后的文章 frontmatter：
 * - 未知字段（如 encrypted/password/passwordHint/hideHomeContent）必须原样保留
 * - published / publishedAt / alias / permalink 永不被表单覆盖（保持原值）
 * - updated/updatedAt 只在显式传入时更新
 */
export function mergePostFrontmatter(existing, form, timeZone) {
  const out = { ...existing };

  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const title = str(form.title);
  if (!title) throw new Error("title 不能为空");

  out.title = title;
  if (form.description !== undefined) {
    if (str(form.description)) out.description = str(form.description);
    else delete out.description;
  }
  if (form.image !== undefined) {
    if (str(form.image)) out.image = str(form.image);
    else delete out.image;
  }
  if (form.category !== undefined) {
    if (str(form.category)) out.category = str(form.category);
    else delete out.category;
  }
  if (form.tags !== undefined) {
    const tags = Array.isArray(form.tags) ? form.tags.map((t) => String(t).trim()).filter(Boolean) : [];
    if (tags.length > 0) out.tags = tags;
    else delete out.tags;
  }

  // 布尔开关：false 时省略字段保持 frontmatter 清爽
  setFlag(out, "pinned", form.pinned);
  setFlag(out, "draft", form.draft);
  setFlag(out, "comment", form.comment, true);

  // 更新时间：仅当显式请求
  if (form.refreshUpdated === true) {
    const { updated, updatedAt } = injectUpdatedTime(timeZone);
    out.updated = updated;
    out.updatedAt = updatedAt;
  }

  // published / publishedAt / alias / permalink：不在此处修改，保留 existing
  return out;
}

/**
 * 合并编辑后的动态 frontmatter。
 * 动态 published 保持原值（编辑不重新浮上来）；images 为整体替换。
 */
export function mergeMomentFrontmatter(existing, form) {
  const out = { ...existing };

  if (form.location !== undefined) {
    const loc = typeof form.location === "string" ? form.location.trim() : "";
    if (loc) out.location = loc;
    else delete out.location;
  }
  if (form.mood !== undefined) {
    if (form.mood) out.mood = String(form.mood);
    else delete out.mood;
  }
  if (form.tags !== undefined) {
    const tags = Array.isArray(form.tags) ? form.tags.map((t) => String(t).trim()).filter(Boolean) : [];
    if (tags.length > 0) out.tags = tags;
    else delete out.tags;
  }

  setFlag(out, "pinned", form.pinned);
  setFlag(out, "draft", form.draft);

  if (form.images !== undefined) {
    const images = Array.isArray(form.images)
      ? form.images
          .map((img) => ({ src: String(img?.src || "").trim(), alt: String(img?.alt || "").trim() }))
          .filter((img) => img.src)
      : [];
    if (images.length > 0) out.images = images;
    else delete out.images;
  }

  // published 保持原值
  return out;
}

function setFlag(obj, key, value, defaultOmitWhenFalse = false) {
  if (value === true) obj[key] = true;
  else if (value === false) {
    if (defaultOmitWhenFalse) delete obj[key];
    else obj[key] = false;
  }
  // undefined：不动
}

// ---------- 新建内容 ----------

/** 新文章完整 frontmatter（含时间注入） */
export function newPostFrontmatter(form, timeZone) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const title = str(form.title);
  if (!title) throw new Error("title 不能为空");

  const data = { title, ...injectPublishedTime(timeZone) };

  if (str(form.description)) data.description = str(form.description);
  if (str(form.image)) data.image = str(form.image);
  if (str(form.category)) data.category = str(form.category);

  const tags = Array.isArray(form.tags) ? form.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  if (tags.length > 0) data.tags = tags;

  if (form.pinned === true) data.pinned = true;
  if (form.draft === true) data.draft = true;
  if (form.comment === false) data.comment = false;

  return data;
}

/** 新动态完整 frontmatter */
export function newMomentFrontmatter(form, timeZone) {
  const data = { published: naiveUtcString() };

  const loc = typeof form.location === "string" ? form.location.trim() : "";
  if (loc) data.location = loc;
  if (form.mood) data.mood = String(form.mood);

  const tags = Array.isArray(form.tags) ? form.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  if (tags.length > 0) data.tags = tags;

  if (form.pinned === true) data.pinned = true;
  if (form.draft === true) data.draft = true;

  const images = Array.isArray(form.images)
    ? form.images
        .map((img) => ({ src: String(img?.src || "").trim(), alt: String(img?.alt || "").trim() }))
        .filter((img) => img.src)
    : [];
  if (images.length > 0) data.images = images;

  return data;
}

// ---------- 从正文提取图片路径（供编辑器"已传图"清单与 image-grid 对话框使用） ----------

const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;

/** 提取正文中引用的全部图片路径 */
export function extractImagePaths(body) {
  const paths = new Set();
  for (const match of body.matchAll(IMAGE_RE)) {
    const raw = match[1].trim();
    const path = raw.split(/\s+/)[0];
    if (path) paths.add(path);
  }
  return [...paths];
}
