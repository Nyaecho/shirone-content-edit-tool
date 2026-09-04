/**
 * 存储/下载统一出口：路由层只 import 本文件。
 * - 生产模式：读优先走本地镜像（未就绪/未命中回退 GitHub API），写先推 GitHub 成功后回写镜像
 * - DEV 模式：读走本地 fs；写操作返回 devDownload 标记，由路由层转成浏览器下载
 */
import { isDev } from "./config.js";
import * as github from "./github.js";
import * as devStore from "./dev-store.js";
import * as mirror from "./mirror-store.js";

/**
 * 远端是否有镜像未包含的新提交（如用户本地 git push 了源码/配置）。
 * 对比远端 HEAD 与镜像同步时的 meta.sha——不同则说明需要同步。
 * DEV 模式 / 镜像未就绪时返回 false（无镜像概念，不提示）。
 * 自身提交（putFile/deleteFile 回写镜像）也会推进远端 HEAD，此函数
 * 只做提示不阻塞任何操作。
 */
export async function remoteAhead() {
  if (isDev() || !mirror.isReady()) return false;
  try {
    const meta = mirror.lastMeta();
    if (!meta?.sha) return false;
    const head = await github.getHeadSha();
    return head != null && head !== meta.sha;
  } catch {
    return false; // 查询失败不提示（网络问题不代表远端有更新）
  }
}

export async function getFile(path) {
  if (isDev()) return devStore.getFile(path);
  // 镜像就绪时优先本地读取；未命中（如新文件尚未同步）回退 GitHub API
  if (mirror.isReady()) {
    const hit = await mirror.getFile(path);
    if (hit) return hit;
  }
  return github.getFile(path);
}

export async function putFile(path, contentRaw, message, sha) {
  if (isDev()) return devStore.putFile(path, contentRaw, message, sha);
  const result = await github.putFile(path, contentRaw, message, sha);
  // 回写镜像；失败不影响保存结果（下次同步会自愈）
  if (mirror.isReady()) {
    await mirror.upsertFile(path, contentRaw).catch(() => {});
    if (result.commitSha) await mirror.advanceMeta(result.commitSha).catch(() => {});
  }
  return result;
}

export async function deleteFile(path, message, sha) {
  if (isDev()) return devStore.deleteFile(path, message, sha);
  const result = await github.deleteFile(path, message, sha);
  if (mirror.isReady()) {
    await mirror.removeFile(path).catch(() => {});
    if (result.commitSha) await mirror.advanceMeta(result.commitSha).catch(() => {});
  }
  return result;
}

export async function listDir(path) {
  if (isDev()) return devStore.listDir(path);
  if (mirror.isReady()) return mirror.listDir(path);
  return github.listDir(path);
}

export async function listTree() {
  if (isDev()) return devStore.listTree();
  if (mirror.isReady()) return mirror.listTree();
  return github.listTree();
}

export const isDevMode = isDev;
