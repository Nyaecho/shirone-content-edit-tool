/**
 * 认证：单密码 + HMAC 签名 HttpOnly Cookie。
 * - 密码比较用 timingSafeEqual 防时序攻击
 * - 登录失败限速：连续失败 10 次锁定 15 分钟（按 IP）
 * - HTTPS 反代下自动追加 Secure（x-forwarded-proto 检测）
 */
import crypto from "node:crypto";
import { config } from "./config.js";

export const COOKIE_NAME = "shirone_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

/** 登录尝试记录：ip → { count, lockedUntil } */
const attempts = new Map();

function hmac(payload) {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

export function checkRateLimit(ip) {
  const rec = attempts.get(ip);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

export function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

export function recordSuccess(ip) {
  attempts.delete(ip);
}

/** 校验密码（timingSafe） */
export function verifyPassword(input) {
  const a = Buffer.from(String(input || ""));
  const b = Buffer.from(config.adminPassword);
  if (a.length !== b.length) {
    // 长度不同也做一次比较，消耗近似时间
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** 生成会话 token：expiry.hmac(expiry) */
export function createSessionToken() {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = String(expiry);
  return `${payload}.${hmac(payload)}`;
}

/** 校验会话 token */
export function verifySessionToken(token) {
  if (typeof token !== "string") return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = Number(payload);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 解析 Cookie 头 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** 认证中间件 */
export function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies[COOKIE_NAME])) {
    return next();
  }
  res.status(401).json({ error: "未登录或会话已过期" });
}

/** 设置会话 Cookie（HTTPS 反代下自动 Secure） */
export function setSessionCookie(req, res) {
  const isHttps = req.headers["x-forwarded-proto"] === "https" || req.secure;
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(createSessionToken())}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

/** 清除会话 Cookie */
export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 登录限速中间件 */
export function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const { locked, retryAfterSec } = checkRateLimit(ip);
  if (locked) {
    return res.status(429).json({ error: `尝试次数过多，请 ${Math.ceil(retryAfterSec / 60)} 分钟后再试` });
  }
  next();
}
