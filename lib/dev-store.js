/**
 * DEV 存储适配器：与 github.js 同接口。
 * - 读操作：直接读本地内容仓文件系统（支持真实测试在线编辑/未知字段合并）
 * - 写操作：不写盘、不推送。返回内存暂存对象，由路由层转成浏览器下载（.md / .zip）
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

function resolveLocal(relPath) {
  return path.join(config.dev.contentDir, relPath);
}

/** 读取文件：返回 { contentRaw, sha, path }；不存在时返回 null */
export async function getFile(relPath) {
  try {
    const contentRaw = await fs.readFile(resolveLocal(relPath), "utf-8");
    return { contentRaw, sha: `dev:${relPath}`, path: relPath };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * "写入"文件：dev 下不落盘，返回待下载产物描述。
 * 返回 { devDownload: true, path, contentRaw, sha }
 */
export async function putFile(relPath, contentRaw, message, sha) {
  return { devDownload: true, path: relPath, contentRaw, sha };
}

/** "删除"文件：dev 下无副作用 */
export async function deleteFile(relPath, message, sha) {
  return { devDeleted: true, path: relPath };
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
  const root = config.dev.contentDir;
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
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
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
