/**
 * 公开只读健康数据路由（无 Cookie 认证，供博客静态页运行时取数）。
 *
 * 数据来源：lib/mihealth.js 直读 mihealth-api 的 SQLite 库（dedup 表）。
 * 隐私边界：只输出快照契约内字段（步数/心率/压力/睡眠），不透传任何原始接口；
 * 若需限制访问，可经反代加 Basic Auth 或前端附加 token 校验（当前为完全公开）。
 */
import express from "express";
import { buildSnapshot, dbConfigured, describeDb } from "../lib/mihealth.js";
import { config } from "../lib/config.js";

export const healthRouter = express.Router();

// ---------- 简单限流：每 IP 每分钟 30 次（保护后端查询） ----------
const RATE_LIMIT = 30;
const WINDOW_MS = 60_000;
const hits = new Map(); // ip -> { count, resetAt }

function rateLimit(req, res, next) {
	const ip = req.ip || "unknown";
	const now = Date.now();
	let h = hits.get(ip);
	if (!h || now >= h.resetAt) {
		h = { count: 0, resetAt: now + WINDOW_MS };
		hits.set(ip, h);
	}
	h.count++;
	if (hits.size > 10_000) hits.clear(); // 防御性清理
	if (h.count > RATE_LIMIT) {
		return res.status(429).json({ ok: false, error: "请求过于频繁，请稍后再试" });
	}
	next();
}

healthRouter.use(rateLimit);

// 公开只读数据 + 跨域消费（博客页可能经 nginx 同域反代，也可能从子域跨域取数）
healthRouter.use((req, res, next) => {
	res.set("Access-Control-Allow-Origin", "*");
	res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.set("Access-Control-Allow-Headers", "Accept");
	res.set("X-Content-Type-Options", "nosniff");
	if (req.method === "OPTIONS") return res.status(204).end();
	next();
});

// ---------- 快照缓存 ----------
let cache = null; // { at, snapshot }

function cachedSnapshot(days) {
	const ttl = config.mihealth.cacheTtlMs;
	if (cache && cache.days === days && Date.now() - cache.at < ttl) return cache.snapshot;
	const snapshot = buildSnapshot({ days });
	cache = { at: Date.now(), days, snapshot };
	return snapshot;
}

/**
 * GET /api/health/status —— 库配置与各键覆盖情况（运维排查；不含个人数据）
 */
healthRouter.get("/status", (req, res) => {
	res.set("X-Content-Type-Options", "nosniff");
	if (!dbConfigured()) {
		return res.json({ ok: true, data: { configured: false } });
	}
	try {
		res.json({ ok: true, data: { configured: true, db: config.mihealth.db, keys: describeDb() } });
	} catch (err) {
		res.status(503).json({ ok: false, error: `数据库不可读: ${err.message}` });
	}
});

/**
 * GET /api/health/snapshot
 * 输出契约见 lib/mihealth.js 头注。天数固定取 MIHEALTH_DAYS 配置
 * （前端零可变参数）；库不可用时返回 503 与原因（页面显示离线态）。
 */
healthRouter.get("/snapshot", (req, res) => {
	if (!dbConfigured()) {
		return res.status(503).json({ ok: false, error: "健康数据功能未配置（缺少 MIHEALTH_DB）" });
	}
	try {
		const days = Math.min(30, Math.max(1, config.mihealth.days || 7));
		res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=540");
		res.set("X-Content-Type-Options", "nosniff");
		res.json(cachedSnapshot(days));
	} catch (err) {
		// 缓存中有旧快照时降级返回（数据短暂停更优于页面报错）
		if (cache) return res.json(cache.snapshot);
		res.status(503).json({ ok: false, error: `健康数据暂不可用: ${err.message}` });
	}
});
