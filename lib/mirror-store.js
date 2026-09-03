/**
 * 本地镜像存储：生产模式下仓库内容的服务端磁盘副本。
 * - lib/sync.js 将分支 tarball 解压为 <MIRROR_DIR>/current（原子替换），写入 meta.json 完成标记
 * - 读接口与 github.js / dev-store.js 同构，由 store.js 在生产模式优先调用
 * - GitHub 写入/删除成功后由 store.js 回写镜像，保证保存后列表即时反映变更
 * - 镜像未就绪（首次启动尚未同步）时由 store.js 兜底走 GitHub API
 */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const currentPath = () => path.join(config.mirror.dir, "current");

/** staging 目录：同步解压的工作区，完成后原子替换为 current */
export function stagingPath() {
  return path.join(config.mirror.dir, ".staging");
}

/** 镜像是否可用（存在同步完成标记 meta.json） */
export function isReady() {
  return fss.existsSync(path.join(currentPath(), "meta.json"));
}

/** 读取同步元信息（尚未同步时返回 null） */
export function lastMeta() {
  try {
    return JSON.parse(fss.readFileSync(path.join(currentPath(), "meta.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** 仓库相对路径 → 镜像绝对路径（防路径穿越） */
function resolveLocal(relPath) {
  const root = path.resolve(currentPath());
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`非法路径：${relPath}`);
  return abs;
}

/** 读取文件：返回 { contentRaw, sha, path }；不存在时返回 null */
export async function getFile(relPath) {
  try {
    const contentRaw = await fs.readFile(resolveLocal(relPath), "utf-8");
    return { contentRaw, sha: null, path: relPath };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** 列出目录（单层） */
export async function listDir(relPath) {
  try {
    const entries = await fs.readdir(resolveLocal(relPath), { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      path: path.join(relPath, e.name).split(path.sep).join("/"),
      type: e.isDirectory() ? "dir" : "file",
      sha: null,
    }));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** 列出整棵树（仅关注 content/ 与 public/），返回 [{ path, type }] */
export async function listTree() {
  const root = currentPath();
  const out = [];

  async function walk(rel, depth) {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "meta.json") continue;
      const relPath = path.join(rel, entry.name).split(path.sep).join("/");
      if (entry.isDirectory()) {
        out.push({ path: relPath, type: "dir" });
        await walk(relPath, depth + 1);
      } else {
        out.push({ path: relPath, type: "file" });
      }
    }
  }

  await walk("", 0);
  return out;
}

// ---------- 供 sync.js 使用 ----------

/** 清空 staging 工作区，并顺带清理历史 .trash-* 残留 */
export async function resetStaging() {
  await fs.rm(stagingPath(), { recursive: true, force: true });
  let entries = [];
  try {
    entries = await fs.readdir(config.mirror.dir);
  } catch {
    /* 镜像根目录尚不存在 */
  }
  for (const name of entries) {
    if (name.startsWith(".trash-")) {
      await fs.rm(path.join(config.mirror.dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
  await fs.mkdir(stagingPath(), { recursive: true });
}

/**
 * 同步完成后原子替换 current：
 * 1. 将 meta.json 写入 staging（isReady 的标记）
 * 2. 旧 current 改名为 .trash-*（O(1)，避免逐文件删除的长窗口）
 * 3. staging 改名为 current；失败则回滚
 * 4. 后台异步删除 .trash-*
 */
export async function promoteStaging(meta) {
  await fs.writeFile(path.join(stagingPath(), "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  const cur = currentPath();
  const trash = path.join(config.mirror.dir, `.trash-${Date.now()}`);
  let hadOld = false;
  try {
    await fs.rename(cur, trash);
    hadOld = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    await fs.rename(stagingPath(), cur);
  } catch (err) {
    if (hadOld) await fs.rename(trash, cur).catch(() => {});
    throw err;
  }
  if (hadOld) fs.rm(trash, { recursive: true, force: true }).catch(() => {});
}

// ---------- 供 store.js 写后回写 ----------

/** 写入/覆盖镜像文件（data 为 Buffer 或字符串） */
export async function upsertFile(relPath, data) {
  const abs = resolveLocal(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
}

/** 删除镜像文件（不存在也视为成功） */
export async function removeFile(relPath) {
  await fs.rm(resolveLocal(relPath), { force: true });
}
