/**
 * 动态（moments）业务服务。
 * 草稿分流：draft=true 时不推 GitHub，存入服务器暂存区；发布时搬运图片与 md。
 */
import * as store from "../lib/store.js";
import * as draftStore from "../lib/draft-store.js";
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

/** 列表 = 已发布动态 + 服务器暂存草稿 */
export async function listMoments() {
  const published = await listPublishedMoments();
  const staged = await listStagedMomentDrafts();
  return [...published, ...staged];
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

/** 暂存动态草稿 → 列表条目（同构 + draftStaged 标记） */
async function listStagedMomentDrafts() {
  const drafts = await draftStore.listDrafts("moment");
  const out = [];
  for (const d of drafts) {
    const file = await draftStore.getDraft("moment", d.draftId);
    if (!file) continue;
    const { data } = parseMarkdown(file.raw);
    out.push({
      id: d.draftId,
      path: `content/moments/${d.draftId}.md`,
      sha: null,
      published: String(data.published || ""),
      location: data.location || "",
      mood: data.mood || "",
      tags: data.tags || [],
      pinned: data.pinned === true,
      draft: true,
      imageCount: Array.isArray(data.images) ? data.images.length : 0,
      excerpt: makeExcerpt(file.raw),
      draftStaged: true,
    });
  }
  return out;
}

export async function getMoment(id) {
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(id)) {
    return null; // 防路径穿越
  }
  // 优先查服务器暂存草稿
  const staged = await draftStore.getDraft("moment", id);
  if (staged) {
    const { data, body } = parseMarkdown(staged.raw);
    const images = (data.images || []).map((img) => ({
      ...img,
      src: img.src?.startsWith("/api/drafts/") ? img.src : `/api/drafts/asset?path=${encodeURIComponent(momentAssetPathFromSrc(img.src))}`,
    }));
    return {
      id,
      path: `content/moments/${id}.md`,
      sha: staged.meta?.repoSha || null,
      frontmatter: { ...data, images },
      body,
      draftStaged: true,
    };
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

  // 草稿：存服务器暂存区（id 也要唯一，避开已发布与已暂存）
  if (form.draft === true) {
    const repoPath = await uniqueMomentPath(day, form.suffix, { includeDrafts: true });
    const id = repoPath.match(MOMENT_FILE_RE)[1];
    const staged = await draftStore.saveDraft("moment", { id, path: `${id}.md` }, raw, {
      title: `${day} 动态草稿`,
    });
    return { path: repoPath, raw, id, draftStaged: true, ...staged };
  }

  const path = await uniqueMomentPath(day, form.suffix);
  const existing = await store.getFile(path);
  if (existing) {
    const err = new Error(`动态文件已存在：${path}`);
    err.code = "CONFLICT";
    throw err;
  }
  const result = await store.putFile(path, raw, "feat(moment): 发布新动态");
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

  // 暂存草稿：保持草稿则覆盖暂存；取消草稿则发布搬运
  if (meta.draftStaged) {
    if (merged.draft === true) {
      const res = await draftStore.saveDraft("moment", { id, path: `${id}.md` }, raw, {
        title: `${String(merged.published || "").slice(0, 10)} 动态草稿`,
        images: meta.frontmatter.images?.map((img) => ({
          repoPath: momentAssetPathFromSrc(img.src),
          webPath: img.src,
        })) || [],
      });
      return { path: meta.path, raw, id, draftStaged: true, ...res };
    }
    // 发布：搬运图片 → 推 md → 清暂存
    const conflict = await store.getFile(meta.path);
    if (conflict) {
      const err = new Error(`目标路径已存在：${meta.path}（暂存草稿与已发布动态冲突）`);
      err.code = "CONFLICT";
      throw err;
    }
    for (const img of await draftStore.collectDraftImages("moment", id)) {
      await store.putFile(img.repoPath, img.buffer, `chore(asset): 发布草稿图片 ${img.repoPath.split("/").pop()}`);
    }
    const result = await store.putFile(meta.path, raw, "feat(moment): 发布动态草稿");
    await draftStore.removeDraft("moment", id);
    return { path: meta.path, raw, id, published: true, ...result };
  }

  const result = await store.putFile(meta.path, raw, "edit(moment): 更新动态", meta.sha);
  return { path: meta.path, raw, id, ...result };
}

export async function deleteMoment(id) {
  const meta = await getMoment(id);
  if (!meta) {
    const err = new Error("动态不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  // 暂存草稿：仅清理服务器暂存区
  if (meta.draftStaged) {
    await draftStore.removeDraft("moment", id);
    return { path: meta.path, draftStaged: true, removed: true };
  }
  const result = await store.deleteFile(meta.path, `chore(moment): 删除动态 ${id}`, meta.sha);
  return { path: meta.path, ...result };
}

/** 为新动态生成唯一文件名：YYYY-MM-DD 或 YYYY-MM-DD-后缀（冲突时自动 -2、-3…）
 *  opts.includeDrafts：同时避开服务器暂存草稿（草稿创建时用） */
async function uniqueMomentPath(day, suffix, opts = {}) {
  const clean = sanitizeSuffix(suffix);
  let candidate = momentFilePath(day, clean);
  let n = 2;
  while (await pathTaken(candidate, opts)) {
    candidate = momentFilePath(day, clean ? `${clean}-${n}` : `${n}`);
    n += 1;
    if (n > 50) break;
  }
  return candidate;
}

async function pathTaken(repoPath, opts) {
  if (await store.getFile(repoPath)) return true;
  if (opts.includeDrafts) {
    const id = repoPath.match(MOMENT_FILE_RE)?.[1];
    if (id && (await draftStore.getDraft("moment", id))) return true;
  }
  return false;
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
