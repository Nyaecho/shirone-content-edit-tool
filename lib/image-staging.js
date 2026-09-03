/**
 * 会话级图片暂存（DEV 模式）：
 * 上传的图片不落盘、不推送，暂存内存中，保存（提交）时按引用收集进 zip。
 * Key: 仓库相对路径；Value: { buffer, contentType }
 * 定期清理超过 2 小时的条目，防止内存膨胀。
 */
const store = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;

export function putImage(repoPath, buffer, contentType) {
  store.set(repoPath, { buffer, contentType, at: Date.now() });
  if (store.size > 500) sweep();
}

export function getImage(repoPath) {
  return store.get(repoPath) || null;
}

export function hasImage(repoPath) {
  return store.has(repoPath);
}

function sweep() {
  const now = Date.now();
  for (const [key, val] of store) {
    if (now - val.at > TTL_MS) store.delete(key);
  }
}
