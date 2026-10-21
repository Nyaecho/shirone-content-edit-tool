/**
 * 小米账号登录路由（需 Cookie 认证）：凭证部署向导 + 免密续期 + 状态查询。
 *
 * 对应 mihealth-api 的 login.py 全链路：账号密码（含图片验证码）→
 * 2FA（手机短信 flag=4 / 邮箱 flag=8）→ 凭证落盘 config.json（600）→
 * 日常 pass_token 免密续期。密码只用于当次请求，不落盘、不记日志。
 */
import express from "express";
import { config } from "../lib/config.js";
import {
	LoginError,
	resume2fa,
	loginPassword,
	readCredentials,
	refreshCredentials,
	writeCredentials,
} from "../lib/mihealth-login.js";
import { dbConfigured } from "../lib/mihealth.js";

export const miLoginRouter = express.Router();

/** LoginError → HTTP 响应（保留 step 语义，前端向导据此流转） */
function fail(res, err) {
	const status = err instanceof LoginError ? 400 : 500;
	res.status(status).json({
		ok: false,
		error: err.message,
		...(err.code != null ? { code: err.code } : {}),
	});
}

/** GET /api/mi-login/status —— 当前凭证概况（脱敏） */
miLoginRouter.get("/status", (req, res) => {
	if (!dbConfigured()) {
		return res.json({ ok: true, data: { configured: false } });
	}
	const cfg = readCredentials(config.mihealth.db);
	if (!cfg) return res.json({ ok: true, data: { configured: false } });
	res.json({
		ok: true,
		data: {
			configured: true,
			hasPassToken: Boolean(cfg.pass_token),
			sessionAt: cfg.session_at ?? null,
			ageDays:
				cfg.session_at != null
					? Math.floor((Date.now() / 1000 - cfg.session_at) / 86400)
					: null,
		},
	});
});

/**
 * POST /api/mi-login/password —— 第一步：提交账号密码。
 * body: { username, password, captcha?, ick?, loginId? }
 * → { step: "ok" } | { step: "captcha", loginId, captchaUrl } | { step: "2fa", loginId, method, hint }
 */
miLoginRouter.post("/password", async (req, res) => {
	const { username, password, captcha, ick, loginId } = req.body || {};
	if (!username || !password) {
		return res.status(400).json({ ok: false, error: "请填写账号与密码" });
	}
	try {
		const r = await loginPassword(username, password, { captcha, ick, loginId });
		if (r.step === "ok") {
			writeCredentials(config.mihealth.db, r.session);
			return res.json({ ok: true, data: { step: "ok" } });
		}
		return res.json({ ok: true, data: r });
	} catch (err) {
		fail(res, err);
	}
});

/**
 * POST /api/mi-login/resume —— 2FA 人工验证完成后的续接。
 * body: { loginId }（用户已在官方验证页完成验证）
 */
miLoginRouter.post("/resume", async (req, res) => {
	const { loginId } = req.body || {};
	if (!loginId) {
		return res.status(400).json({ ok: false, error: "缺少 loginId" });
	}
	try {
		const r = await resume2fa(loginId);
		if (r.step === "ok") {
			writeCredentials(config.mihealth.db, r.session);
			return res.json({ ok: true, data: { step: "ok" } });
		}
		res.json({ ok: true, data: r });
	} catch (err) {
		fail(res, err);
	}
});

/** POST /api/mi-login/upload —— 上传凭证文件（mihealth-api login.py 产出的 config.json）。
 * body: 完整 config.json 内容（ssecurity/service_token/cuser_id/pass_token…）。
 * 2FA 验证态绑定浏览器 cookie，服务端无法跨客户端续接（实测），故凭证
 * 部署以「本地 login.py → 上传」为主通道；后续用 /refresh 免密续期即可。 */
	miLoginRouter.post("/upload", async (req, res) => {
	if (!dbConfigured()) {
		return res.status(503).json({
			ok: false,
			error: "未配置 MIHEALTH_DB——请在服务器 .env 指定 mihealth.db 路径并重启服务",
		});
	}
	const cfg = req.body || {};
	const required = ["ssecurity", "service_token", "cuser_id"];
	const missing = required.filter((k) => !cfg[k]);
	if (missing.length) {
		return res.status(400).json({
			ok: false,
			error: `凭证缺少必需字段：${missing.join("、")}（应上传 mihealth-api login.py 生成的完整 config.json）`,
		});
	}
	if (!cfg.pass_token) {
		// 没有 pass_token 也能用，但无法免密续期——提示而非拒绝
		console.warn("[mi-login] 上传的凭证无 pass_token，过期后需重新上传");
	}
	try {
		writeCredentials(config.mihealth.db, {
			ssecurity: cfg.ssecurity,
			service_token: cfg.service_token,
			cuser_id: cfg.cuser_id,
			user_id: cfg.user_id,
			pass_token: cfg.pass_token,
			sid: cfg.sid || "miothealth",
			ts: Math.floor(Date.now() / 1000),
		});
		// 凭证就位即自动开始：库空 → 全量回填；否则增量补拉（后台异步，不阻塞响应）
		const { getSyncer, startAutoSync } = await import("../lib/mihealth-sync.js");
		startAutoSync();
		const s = getSyncer();
		let mode = "incremental";
		try {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(config.mihealth.db, { readOnly: true });
			const n = db.prepare("SELECT COUNT(*) c FROM dedup").get().c;
			db.close();
			if (!n) mode = "backfill";
		} catch {
			mode = "backfill"; // 库还没建
		}
		s.run(mode).catch(() => {});
		res.json({ ok: true, data: { step: "ok", autoSync: mode } });
	} catch (err) {
		fail(res, err);
	}
});

/** GET /api/mi-login/sync —— 同步状态/手动触发（凭证就位后数据自动化入口）
 *  ?mode=backfill 全量回填（首次）；默认 incremental 增量 */
miLoginRouter.get("/sync", async (req, res) => {
	if (!dbConfigured()) {
		return res.status(503).json({ ok: false, error: "未配置 MIHEALTH_DB" });
	}
	try {
		const { getSyncer, startAutoSync } = await import("../lib/mihealth-sync.js");
		startAutoSync();
		const s = getSyncer();
		if (req.query.run !== undefined) {
			const mode = req.query.run === "backfill" ? "backfill" : "incremental";
			// backfill 可能跑几分钟：异步启动，立即返回进行中状态
			const p = s.run(mode);
			if (mode === "incremental") await p;
			return res.json({ ok: true, data: { running: s.running, lastResult: s.lastResult } });
		}
		res.json({ ok: true, data: { running: s.running, lastResult: s.lastResult } });
	} catch (err) {
		fail(res, err);
	}
});

/** POST /api/mi-login/refresh —— 免密续期（pass_token 换新 serviceToken） */
miLoginRouter.post("/refresh", async (req, res) => {
	if (!dbConfigured()) {
		return res.status(503).json({ ok: false, error: "未配置 MIHEALTH_DB" });
	}
	const cfg = readCredentials(config.mihealth.db);
	if (!cfg) {
		return res.status(400).json({ ok: false, error: "尚未部署凭证，请先账号密码登录" });
	}
	try {
		const session = await refreshCredentials(cfg);
		writeCredentials(config.mihealth.db, session);
		res.json({ ok: true, data: { step: "ok", refreshedAt: session.ts } });
	} catch (err) {
		fail(res, err);
	}
});
