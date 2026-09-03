/**
 * 存储/下载统一出口：路由层只 import 本文件。
 * - 生产模式：转发 lib/github.js
 * - DEV 模式：读走本地 fs；写操作返回 devDownload 标记，由路由层转成浏览器下载
 */
import { isDev } from "./config.js";
import * as github from "./github.js";
import * as devStore from "./dev-store.js";

export async function getFile(path) {
  return isDev() ? devStore.getFile(path) : github.getFile(path);
}

export async function putFile(path, contentRaw, message, sha) {
  return isDev() ? devStore.putFile(path, contentRaw, message, sha) : github.putFile(path, contentRaw, message, sha);
}

export async function deleteFile(path, message, sha) {
  return isDev() ? devStore.deleteFile(path, message, sha) : github.deleteFile(path, message, sha);
}

export async function listDir(path) {
  return isDev() ? devStore.listDir(path) : github.listDir(path);
}

export async function listTree() {
  return isDev() ? devStore.listTree() : github.listTree();
}

export const isDevMode = isDev;
