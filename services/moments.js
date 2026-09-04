/**
 * 动态（moments）业务服务。
 * 草稿即仓库文件：draft: true 与发布内容同路径存储，仓库为唯一事实源。
 */
import * as store from "../lib/store.js";
import {
  parseMarkdown,
  buildMarkdown,
  momentFilePath,
  momentAssetPath,
  mergeMomentFrontmatter,
  newMomentFrontmatter,
} from "../lib/content.js";
import { config } from "../lib/config.js";

const MOMENT_FILE_RE = /^content\/moments\/(.+)\.md$/;

/** 列表 = 仓库全部动态（含 draft: true 草稿，前端按需过滤） */
export async function listMoments() {
  return listPublishedMoments();
}

async function listPublishedMoments() {
  const tree = await store.listTree();
  const files = tree.filter((t) => t.type === "file" && MOMENT_FILE_RE.test(t.path));

  const list = await pooled(files, 8, async (file) => {
    try {
      const f = await store.getFile(file.path);
      if (!f) return null;
      const { data } = parseMarkdown(f.contentRaw);
      const id = file.path.match(MOMENT_FILE_RE)[1];
      return {
        id,
        path: file.path,
        sha: f.sha,
        published: String(data.published || ""),
        location: data.location || "",
        mood: data.mood || "",
        tags: data.tags || [],
        pinned: data.pinned === true,
        draft: data.draft === true,
        imageCount: Array.isArray(data.images) ? data.images.length : 0,
        excerpt: makeExcerpt(f.contentRaw),
      };
    } catch {
      return null;
    }
  });

  return list.filter(Boolean).sort((a, b) => (a.published < b.published ? 1 : -1));
}

export async function getMoment(id) {
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(id)) {
    return null; // 防路径穿越
  }
  const path = `content/moments/${id}.md`;
  const file = await store.getFile(path);
  if (!file) return null;
  const { data, body } = parseMarkdown(file.contentRaw);
  return {
    id,
    path,
    sha: file.sha,
    frontmatter: data,
    body,
  };
}

/** 动态图片 src（/images/albums/...）→ 仓库路径（public/images/albums/...） */
function momentAssetPathFromSrc(src) {
  const s = String(src || "").split("?")[0];
  return s.startsWith("/") ? `public${s}` : s;
}

export async function createMoment(form, body, timeZone) {
  const data = newMomentFrontmatter(form, timeZone);
  const day = data.published.slice(0, 10);
  const raw = buildMarkdown(data, body);

  // 草稿与发布同一存储：draft: true 写进 frontmatter，统一推 GitHub
  const path = await uniqueMomentPath(day, form.suffix);
  const existing = await store.getFile(path);
  if (existing) {
    const err = new Error(`动态文件已存在：${path}`);
    err.code = "CONFLICT";
    throw err;
  }
  const result = await store.putFile(
    path,
    raw,
    form.draft === true ? "feat(moment): 新增动态草稿" : "feat(moment): 发布新动态",
  );
  return { path, raw, id: path.match(MOMENT_FILE_RE)[1], ...result };
}

export async function updateMoment(id, form, body) {
  const meta = await getMoment(id);
  if (!meta) {
    const err = new Error("动态不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const merged = mergeMomentFrontmatter(meta.frontmatter, form);
  if (merged.draft === false) delete merged.draft; // 发布时彻底移除 draft 字段
  const raw = buildMarkdown(merged, body);

  const result = await store.putFile(
    meta.path,
    raw,
    merged.draft === true ? "edit(moment): 更新动态草稿" : "edit(moment): 更新动态",
    meta.sha,
  );
  return { path: meta.path, raw, id, ...result };
}

export async function deleteMoment(id) {
  const meta = await getMoment(id);
  if (!meta) {
    const err = new Error("动态不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const result = await store.deleteFile(meta.path, `chore(moment): 删除动态 ${id}`, meta.sha);
  return { path: meta.path, ...result };
}

/** 为新动态生成唯一文件名：YYYY-MM-DD 或 YYYY-MM-DD-后缀（冲突时自动 -2、-3…） */
async function uniqueMomentPath(day, suffix) {
  const clean = sanitizeSuffix(suffix);
  let candidate = momentFilePath(day, clean);
  let n = 2;
  while (await store.getFile(candidate)) {
    candidate = momentFilePath(day, clean ? `${clean}-${n}` : `${n}`);
    n += 1;
    if (n > 50) break;
  }
  return candidate;
}

function sanitizeSuffix(s) {
  if (!s || typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function makeExcerpt(raw) {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body.replace(/[#>*`~[\]!()-]/g, "").trim().slice(0, 80);
}

async function pooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
