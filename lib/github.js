/**
 * 生产存储：GitHub Contents API 封装（global fetch，无第三方依赖）。
 * 所有方法以内容仓仓库根为基准的相对路径工作。
 */
import { config } from "./config.js";

const API_BASE = "https://api.github.com";

function repo() {
  return `${config.github.owner}/${config.github.repo}`;
}

function headers(extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.github.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.message ? `: ${body.message}` : "";
    } catch {
      /* ignore */
    }
    const err = new Error(`GitHub API ${res.status} ${detail || res.statusText}`);
    err.status = res.status;
    // 409 冲突：远端已有更新的提交（如用户 git push 直改了该文件），提示重新打开
    if (res.status === 409) {
      err.message = "文件在远端已被更新（可能你用 git 推送过修改）：请点击右上角同步后，重新打开该内容再编辑保存";
    }
    throw err;
  }
  return res.json();
}

/** 读取文件：返回 { contentRaw, sha, path }；不存在时返回 null */
export async function getFile(path) {
  try {
    const data = await request(`/repos/${repo()}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.github.branch)}`, {
      headers: headers(),
    });
    // 文本文件走 base64
    const contentRaw = Buffer.from(data.content || "", "base64").toString("utf-8");
    return { contentRaw, sha: data.sha, path: data.path };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * 创建或更新文件（path 为文件完整路径）。
 * contentRaw 为 UTF-8 字符串（文本文件）或 Buffer（二进制图片）。
 */
export async function putFile(path, contentRaw, message, sha) {
  const content = Buffer.isBuffer(contentRaw)
    ? contentRaw.toString("base64")
    : Buffer.from(contentRaw, "utf-8").toString("base64");
  const body = {
    message,
    content,
    branch: config.github.branch,
    committer: { name: config.commitAuthor.name, email: config.commitAuthor.email },
  };
  if (sha) body.sha = sha;
  const data = await request(`/repos/${repo()}/contents/${encodePath(path)}`, {
    method: "PUT",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return {
    commitUrl: data.commit?.html_url || null,
    commitSha: data.commit?.sha || null,
    sha: data.content?.sha || null,
  };
}

/** 删除文件 */
export async function deleteFile(path, message, sha) {
  const body = { message, branch: config.github.branch, sha };
  const data = await request(`/repos/${repo()}/contents/${encodePath(path)}`, {
    method: "DELETE",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { commitUrl: data.commit?.html_url || null, commitSha: data.commit?.sha || null };
}

/** 列出目录内容（单层），返回 [{ name, path, type, sha }] */
export async function listDir(path) {
  const data = await request(`/repos/${repo()}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.github.branch)}`, {
    headers: headers(),
  });
  return Array.isArray(data) ? data : [];
}

/**
 * 一次调用列出整棵树，返回 [{ path, type }]。
 * 用于快速构建文章/动态列表（避免逐个目录请求）。
 */
export async function listTree() {
  const data = await request(
    `/repos/${repo()}/git/trees/${encodeURIComponent(config.github.branch)}?recursive=1`,
    { headers: headers() },
  );
  // 类型归一化：GitHub 用 blob/tree，DEV 本地存储用 file/dir——
  // 统一转成 file/dir，消费端（posts/moments）只认 file。
  const TYPE_MAP = { blob: "file", tree: "dir" };
  return (data.tree || []).map((item) => ({
    path: item.path,
    type: TYPE_MAP[item.type] || item.type,
  }));
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** 获取分支 HEAD commit sha（用于检测远端是否有镜像之外的新提交） */
export async function getHeadSha() {
  const data = await request(
    `/repos/${repo()}/git/ref/heads/${encodeURIComponent(config.github.branch)}`,
    { headers: headers() },
  );
  return data.object?.sha || null;
}
