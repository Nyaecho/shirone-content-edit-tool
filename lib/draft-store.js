/**
 * 草稿暂存区：勾选"草稿"的内容不推 GitHub，只存服务器磁盘。
 * - 目录：.drafts/<kind>/<id>.md（kind: post | moment），与仓库同构的相对路径结构
 * - 图片：.drafts/assets/<kind>/<...>，上传时若内容为草稿状态则落这里
 * - 发布（取消草稿后保存）：把暂存的 md + 图片搬运推送到 GitHub，成功后删除暂存
 * - 与镜像目录分离，互不影响；DEV 模式同样可用（本地可真实预览暂存效果）
 */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { runtimeDirs } from "./config.js";

const draftsRoot = () => runtimeDirs.drafts;

function resolveDraft(relPath) {
  const root = path.resolve(draftsRoot());
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`非法路径：${relPath}`);
  return abs;
}

// ---------- 元数据 ----------

/** 每个草稿一份 sidecar meta：记录 id、kind、标题、创建/更新时间、关联图片 */
function metaPathOf(relPath) {
  return `${relPath}.meta.json`;
}

export async function readMeta(relPath) {
  try {
    return JSON.parse(await fs.readFile(resolveDraft(metaPathOf(relPath)), "utf-8"));
  } catch {
    return null;
  }
}

async function writeMeta(relPath, meta) {
  await fs.writeFile(resolveDraft(metaPathOf(relPath)), JSON.stringify(meta, null, 2), "utf-8");
}

// ---------- 草稿读写 ----------

/** 列出某类草稿的全部条目（含 meta 摘要），按更新时间倒序 */
export async function listDrafts(kind) {
  const dir = resolveDraft(kind);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const relPath = `${kind}/${e.name}`;
    const [file, meta] = await Promise.all([
      fs.readFile(resolveDraft(relPath), "utf-8").catch(() => null),
      readMeta(relPath),
    ]);
    if (file == null) continue;
    out.push({
      draftId: meta?.id || e.name.replace(/\.md$/, ""),
      kind,
      path: relPath,
      title: meta?.title || e.name,
      createdAt: meta?.createdAt || null,
      updatedAt: meta?.updatedAt || null,
      images: meta?.images || [],
    });
  }
  return out.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
}

/**
 * 暂存（创建/覆盖）一个草稿。
 * @param {string} kind post | moment
 * @param {object} ids { id, path }：id 为草稿标识（post 用 slug，moment 用日期-后缀）
 * @param {string} raw 完整 Markdown 文本
 * @param {object} meta 摘要 { title, images: [{repoPath, webPath}] }
 */
export async function saveDraft(kind, ids, raw, meta = {}) {
  const relPath = `${kind}/${ids.path}`;
  const abs = resolveDraft(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, raw, "utf-8");
  const now = new Date().toISOString();
  const prev = (await readMeta(relPath)) || {};
  await writeMeta(relPath, {
    ...prev,
    id: ids.id,
    kind,
    title: meta.title || prev.title || ids.id,
    images: meta.images || prev.images || [],
    createdAt: prev.createdAt || now,
    updatedAt: now,
  });
  return { draftPath: relPath, id: ids.id };
}

/** 读取草稿原文（不存在返回 null） */
export async function getDraft(kind, id) {
  const relPath = `${kind}/${id}.md`;
  try {
    const raw = await fs.readFile(resolveDraft(relPath), "utf-8");
    return { raw, meta: await readMeta(relPath) };
  } catch {
    return null;
  }
}

/** 删除草稿（发布搬运成功后调用） */
export async function removeDraft(kind, id) {
  const relPath = `${kind}/${id}.md`;
  await fs.rm(resolveDraft(relPath), { force: true });
  await fs.rm(resolveDraft(metaPathOf(relPath)), { force: true });
}

// ---------- 草稿图片 ----------

/** 草稿图片落盘：返回 { repoPath, webPath }（webPath 经 /api/drafts/asset 代理读取） */
export async function putDraftImage(kind, repoPath, buffer, contentType = "") {
  const rel = `assets/${repoPath}`;
  const abs = resolveDraft(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  // 记录 contentType，代理响应时使用
  if (contentType) {
    await fs.writeFile(`${abs}.ct`, contentType, "utf-8").catch(() => {});
  }
  return {
    repoPath,
    webPath: `/api/drafts/asset?path=${encodeURIComponent(repoPath)}`,
  };
}

/** 读取草稿图片（代理用）：返回 { buffer, contentType } 或 null */
export async function getDraftImage(repoPath) {
  const rel = `assets/${repoPath}`;
  let buffer;
  try {
    buffer = await fs.readFile(resolveDraft(rel));
  } catch {
    return null;
  }
  let contentType = "";
  try {
    contentType = await fs.readFile(resolveDraft(`${rel}.ct`), "utf-8");
  } catch {
    /* 无记录则嗅探 */
  }
  return { buffer, contentType };
}

/**
 * 发布搬运：把草稿关联图片从暂存区移到镜像/仓库路径。
 * 返回 [{ repoPath, buffer }]，由调用方推送到 GitHub（或 DEV 下载）。
 */
export async function collectDraftImages(kind, id) {
  const meta = await readMeta(`${kind}/${id}.md`);
  const out = [];
  for (const img of meta?.images || []) {
    const data = await getDraftImage(img.repoPath).catch(() => null);
    if (data) out.push({ repoPath: img.repoPath, buffer: data.buffer });
  }
  return out;
}

// ---------- 调试/运维 ----------

export function draftsDirExists() {
  return fss.existsSync(draftsRoot());
}
