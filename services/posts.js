/**
 * 文章（posts）业务服务：列表、详情、创建、更新、删除。
 * 存储层按 DEV_MODE 选择 github.js 或 dev-store.js，本层无感。
 * 草稿分流：draft=true 时不推 GitHub，存入服务器暂存区（.drafts/）；发布时搬运。
 */
import * as store from "../lib/store.js";
import * as draftStore from "../lib/draft-store.js";
import {
  parseMarkdown,
  buildMarkdown,
  validateSlug,
  isReservedSlug,
  postFilePath,
  postAssetPath,
  mergePostFrontmatter,
  newPostFrontmatter,
  extractImagePaths,
} from "../lib/content.js";

/** 列表 = 仓库已发布文章 + 服务器暂存草稿（合并展示，草稿带 draftStaged 标记） */
/** 列表 = 仓库已发布文章 + 服务器暂存草稿（草稿带 draftStaged 标记） */
export async function listPosts() {
  const summarized = await listPublishedPosts();
  const staged = await listStagedDrafts();
  return [...summarized, ...staged];
}

/** 仓库已发布文章列表（原 listPosts 主体） */
async function listPublishedPosts() {
  const tree = await store.listTree();
  const posts = new Map();

  for (const item of tree) {
    if (item.type !== "file") continue;
    let m;
    if ((m = item.path.match(/^content\/posts\/([^/]+)\/index\.md$/))) {
      const slug = m[1];
      posts.set(slug, { slug, path: item.path, folder: true });
    } else if ((m = item.path.match(/^content\/posts\/([^/]+)\.md$/))) {
      const slug = m[1];
      if (!posts.has(slug)) posts.set(slug, { slug, path: item.path, folder: false });
    }
  }

  const list = [...posts.values()];
  // 并发拉取每篇的 frontmatter 摘要（限并发 8）
  const summarized = await pooled(list, 8, async (post) => {
    try {
      const file = await store.getFile(post.path);
      if (!file) return null;
      const { data } = parseMarkdown(file.contentRaw);
      return {
        slug: post.slug,
        path: post.path,
        folder: post.folder,
        title: data.title || post.slug,
        published: formatDate(data.published),
        updated: formatDate(data.updated),
        description: data.description || "",
        category: data.category || "",
        tags: data.tags || [],
        pinned: data.pinned === true,
        draft: data.draft === true,
        comment: data.comment !== false,
      };
    } catch {
      return null;
    }
  });

  return summarized.filter(Boolean).sort((a, b) => (a.published < b.published ? 1 : -1));
}

/** 服务器暂存草稿 → 列表摘要（与仓库文章同构，补充 draftStaged 标记与草稿 id） */
async function listStagedDrafts() {
  const drafts = await draftStore.listDrafts("post");
  const out = [];
  for (const d of drafts) {
    const file = await draftStore.getDraft("post", d.draftId);
    if (!file) continue;
    const { data } = parseMarkdown(file.raw);
    out.push({
      slug: d.draftId,
      path: postFilePath(d.draftId),
      folder: true,
      title: data.title || d.title || d.draftId,
      published: "未发布",
      updated: formatDate(data.updated) || (d.updatedAt || "").slice(0, 10),
      description: data.description || "",
      category: data.category || "",
      tags: data.tags || [],
      pinned: data.pinned === true,
      draft: true,
      comment: data.comment !== false,
      draftStaged: true, // ← 前端据此标“仅存服务器”
    });
  }
  return out;
}

export async function getPost(slug) {
  // 优先查服务器暂存草稿（草稿不存在于仓库）
  const staged = await draftStore.getDraft("post", slug);
  if (staged) {
    const { data, body } = parseMarkdown(staged.raw);
    const images = (staged.meta?.images || []).map((img) => ({
      repoPath: img.repoPath,
      webPath: `/api/drafts/asset?path=${encodeURIComponent(img.repoPath)}`,
      name: img.repoPath.split("/").pop(),
    }));
    return {
      slug,
      path: postFilePath(slug),
      folder: true,
      sha: staged.meta?.repoSha || null,
      frontmatter: data,
      body,
      images,
      referencedImages: extractImagePaths(body),
      draftStaged: true,
    };
  }
  const meta = await resolvePostPath(slug);
  if (!meta) return null;
  const file = await store.getFile(meta.path);
  if (!file) return null;
  const { data, body } = parseMarkdown(file.contentRaw);

  // 已上传到文章目录的图片（供编辑器"已传图"清单）
  let images = [];
  if (meta.folder) {
    const dirPath = meta.path.replace(/\/index\.md$/, "");
    try {
      const entries = await store.listDir(dirPath);
      images = entries
        .filter((e) => e.type === "file" && /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(e.name))
        .map((e) => ({ repoPath: e.path, webPath: relativeToWeb(e.path), name: e.name }));
    } catch {
      /* 目录不存在则忽略 */
    }
  }

  return {
    slug,
    path: meta.path,
    folder: meta.folder,
    sha: file.sha,
    frontmatter: data,
    body,
    images,
    referencedImages: extractImagePaths(body),
  };
}

export function validatePostInput(form, { isNew }) {
  const errors = [];
  const slugErr = validateSlug(form.slug || "");
  if (slugErr) errors.push(`slug 无效：${slugErr}`);
  else if (isReservedSlug(form.slug)) errors.push(`slug "${form.slug}" 与核心路由冲突，请换一个`);
  if (!form.title || !String(form.title).trim()) errors.push("标题不能为空");
  return errors;
}

export async function createPost(form, body, timeZone) {
  const data = newPostFrontmatter(form, timeZone);
  const raw = buildMarkdown(data, body);
  const path = postFilePath(form.slug);

  // 草稿：只存服务器暂存区，不推 GitHub
  if (form.draft === true) {
    const existing = await draftStore.getDraft("post", form.slug);
    if (existing) {
      const err = new Error(`草稿已存在：${form.slug}（请直接编辑该草稿）`);
      err.code = "CONFLICT";
      throw err;
    }
    const staged = await draftStore.saveDraft("post", { id: form.slug, path: `${form.slug}.md` }, raw, {
      title: form.title,
    });
    return { path, raw, slug: form.slug, draftStaged: true, ...staged };
  }

  const existing = await store.getFile(path);
  if (existing) {
    const err = new Error(`文章已存在：${path}`);
    err.code = "CONFLICT";
    throw err;
  }
  const result = await store.putFile(
    path,
    raw,
    `feat(post): 新增文章《${form.title}》`,
  );
  return { path, raw, slug: form.slug, ...result };
}

export async function updatePost(slug, form, body, timeZone) {
  // 暂存草稿的编辑：仍在暂存区内覆盖（保持草稿），或取消草稿 → 发布搬运
  const staged = await draftStore.getDraft("post", slug);
  if (staged) {
    const { data: existing } = parseMarkdown(staged.raw);
    const merged = mergePostFrontmatter(existing, form, timeZone);
    if (merged.draft === false) delete merged.draft; // 发布时彻底移除 draft 字段
    const raw = buildMarkdown(merged, body);

    if (merged.draft === true) {
      // 继续保持草稿：覆盖暂存
      const res = await draftStore.saveDraft("post", { id: slug, path: `${slug}.md` }, raw, {
        title: merged.title,
        images: staged.meta?.images || [],
      });
      return { path: postFilePath(slug), raw, slug, draftStaged: true, ...res };
    }

    // 取消草稿 → 发布：搬运暂存图片到 GitHub，再推 md，最后清暂存
    const targetPath = postFilePath(slug);
    const conflict = await store.getFile(targetPath);
    if (conflict) {
      const err = new Error(`目标路径已存在：${targetPath}（暂存草稿与已发布文章冲突）`);
      err.code = "CONFLICT";
      throw err;
    }
    for (const img of await draftStore.collectDraftImages("post", slug)) {
      await store.putFile(img.repoPath, img.buffer, `chore(asset): 发布草稿图片 ${img.repoPath.split("/").pop()}`);
    }
    const result = await store.putFile(targetPath, raw, `feat(post): 发布草稿文章《${merged.title}》`);
    await draftStore.removeDraft("post", slug);
    return { path: targetPath, raw, slug, published: true, ...result };
  }

  const meta = await resolvePostPath(slug);
  if (!meta) {
    const err = new Error("文章不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const file = await store.getFile(meta.path);
  if (!file) {
    const err = new Error("文章不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const { data: existing, body: existingBody } = parseMarkdown(file.contentRaw);
  const merged = mergePostFrontmatter(existing, form, timeZone);
  // 发布（非草稿）时彻底移除 draft 字段，避免仓里残留 draft: false
  if (merged.draft === false) delete merged.draft;
  const raw = buildMarkdown(merged, body);

  const targetPath = postFilePath(form.slug || slug);
  // slug 变更 = 移动文件（旧路径单文件形态或目录由人工清理，v1 不自动迁移图片）
  const moved = targetPath !== meta.path;
  if (moved) {
    const conflict = await store.getFile(targetPath);
    if (conflict) {
      const err = new Error(`目标路径已存在：${targetPath}`);
      err.code = "CONFLICT";
      throw err;
    }
  }

  const result = await store.putFile(
    targetPath,
    raw,
    moved ? `refactor(post): 移动 ${meta.path} → ${targetPath}` : `edit(post): 更新文章《${merged.title}》`,
    moved ? undefined : file.sha,
  );

  // 移动时删除旧文件（乐观并发：带旧 sha）
  let oldRemoved = false;
  if (moved) {
    try {
      await store.deleteFile(meta.path, `refactor(post): 移除旧路径 ${meta.path}`, file.sha);
      oldRemoved = true;
    } catch {
      /* 旧文件可能已不存在 */
    }
  }

  return { path: targetPath, raw, slug: form.slug || slug, moved, oldPath: moved ? meta.path : null, oldRemoved, ...result };
}

export async function deletePost(slug) {
  // 暂存草稿：直接清理服务器暂存区
  const staged = await draftStore.getDraft("post", slug);
  if (staged) {
    await draftStore.removeDraft("post", slug);
    return { path: postFilePath(slug), draftStaged: true, removed: true };
  }
  const meta = await resolvePostPath(slug);
  if (!meta) {
    const err = new Error("文章不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const file = await store.getFile(meta.path);
  if (!file) {
    const err = new Error("文章不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  const result = await store.deleteFile(meta.path, `chore(post): 删除文章《${slug}》`, file.sha);
  return { path: meta.path, ...result };
}

/** 解析 slug → 文件路径（优先文件夹式） */
async function resolvePostPath(slug) {
  const indexPath = postFilePath(slug);
  const flatPath = `content/posts/${slug}.md`;
  for (const candidate of [indexPath, flatPath]) {
    const file = await store.getFile(candidate);
    if (file) return { path: candidate, folder: candidate === indexPath };
  }
  return null;
}

/** 仓库相对路径 → web 路径（public/ 前缀剥离） */
function relativeToWeb(repoPath) {
  return repoPath.startsWith("public/") ? `/${repoPath.slice("public/".length)}` : `/${repoPath}`;
}

function formatDate(v) {
  if (!v) return "";
  // gray-matter 可能解析出 Date 对象（YAML date），统一转 ISO 后截取日期
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** 简易并发池 */
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
