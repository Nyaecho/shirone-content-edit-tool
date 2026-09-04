/**
 * 文章（posts）业务服务：列表、详情、创建、更新、删除。
 * 存储层按 DEV_MODE 选择 github.js 或 dev-store.js，本层无感。
 * 草稿即仓库文件：draft: true 与发布内容同路径存储，仓库为唯一事实源。
 */
import * as store from "../lib/store.js";
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

/** 列表 = 仓库全部文章（含 draft: true 草稿，前端按需过滤） */
export async function listPosts() {
  return listPublishedPosts();
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

export async function getPost(slug) {
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

  // 草稿与发布同一存储：draft: true 写进 frontmatter，统一推 GitHub
  const existing = await store.getFile(path);
  if (existing) {
    const err = new Error(`文章已存在：${path}`);
    err.code = "CONFLICT";
    throw err;
  }
  const result = await store.putFile(
    path,
    raw,
    form.draft === true
      ? `feat(post): 新增草稿《${form.title}》`
      : `feat(post): 新增文章《${form.title}》`,
  );
  return { path, raw, slug: form.slug, ...result };
}

export async function updatePost(slug, form, body, timeZone) {
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
