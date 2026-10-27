/**
 * API 客户端与全局提示（toast）。
 * api()：相对路径请求（反代子路径友好）+ 统一错误信息 + DEV 下载响应识别。
 */
import { triggerDownload } from "./utils.js";

export async function api(path, options = {}) {
  const res = await fetch(`api${path}`, {
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...options,
    body: options.body instanceof FormData || typeof options.body === "string" ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("text/markdown") || contentType.includes("application/zip")) {
    return { download: res, filename: res.headers.get("X-Suggested-Filename") || "download.md" };
  }
  // 非 JSON 响应（如反代/WAF 拦截页、路由 404 的 HTML）直接报状态码，避免误导性的"响应解析失败"
  if (!contentType.includes("application/json")) {
    throw new Error(`请求失败（${res.status}，非 JSON 响应——检查路径或反向代理）`);
  }
  const json = await res.json().catch(() => ({ ok: false, error: `响应解析失败（${res.status}）` }));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `请求失败（${res.status}）`);
  }
  return json.data;
}

export function toast(msg, isErr = false) {
  const box = document.getElementById("toast-box");
  const el = document.createElement("div");
  el.className = `toast${isErr ? " err" : ""}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

export { triggerDownload };
