/**
 * 小米账号登录（passport → 米健康 serviceToken）——自 mihealth-api login.py 移植。
 *
 * 登录状态机（与服务端交互分四步，前端向导逐步驱动）：
 *   1) password  提交账号密码 → 可能要求图片验证码（captcha）/ 二次验证（2FA）/ 直接成功
 *   2) captcha   提交验证码后重走 ①，或再次进入 2FA
 *   3) 2fa       触发验证码下发（手机短信 flag=4 / 邮箱 flag=8）→ 提交验证码完成
 *   4) refresh   pass_token 免密续期（日常，passToken 有效期约 1~2 个月）
 *
 * 关键对齐点（实测坑位，与服务端行为一一对应）：
 * - 密码哈希是**单次 MD5 大写**（双重 MD5 是另一套 Web 端，会稳定 70016）；
 * - cookie 必须带 sdkVersion=accountsdk-18.8.15 与 deviceId，UA 要像 App；
 * - 验证码字段名是 captCode（不是 icode），ick 走 cookie，字段放 query；
 * - 2FA 通道由 identity/list 的 flag 决定：4=手机（还需 sendPhoneTicket），8=邮箱；
 *   identity/* 端点 UA 必须带 DeviceId/UserId 段，否则返回空响应体；
 * - 响应体带 "&&&START&&&" 前缀，必须剥离后再 JSON 解析；
 * - 免密续期：serviceLogin 必须带 passToken cookie 发一次才返回 code=0 + STS location，
 *   STS 跳转不要自动跟随；
 * - 会话（含 cookie）必须跨步骤复用：内存 Map 保存，登录完成/失败即弃。
 *
 * 安全：密码只用于当次请求，不落盘；落盘凭证写 MIHEALTH_DB 同目录 config.json（600）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ACCOUNT_HOST_DEFAULT = "https://account.xiaomi.com";
/** 测试钩子：测试时可覆写为本地 mock 服务（生产勿动） */
export let ACCOUNT_HOST = ACCOUNT_HOST_DEFAULT;
export function _setAccountHostForTest(host) {
	ACCOUNT_HOST = host;
}
const IDENTITY = "https://account.xiaomi.com/identity";
const SID_HEALTH = "miothealth";
const SDK_VERSION = "accountsdk-18.8.15";
const UA_BASE = "XiaomiHealthApi-ABCDE APP/com.xiaomi.mihome APPV/10.5.201";
const UA_APP =
	"MiHome/11.3.203 (com.xiaomi.mihome; build:11.3.203; Android 9) APP/com.xiaomi.mihome APPV/11.3.203 DeviceId/{dev} UserId/{uid} Platform/Android Region/CN L/zh_CN";

/** 每步的最大重试（passport/STS 直连偶发超时） */
const RETRIES = 3;

export class LoginError extends Error {
	constructor(message, { code = null, captchaUrl = null, need2fa = null } = {}) {
		super(message);
		this.code = code;
		this.captchaUrl = captchaUrl;
		this.need2fa = need2fa;
	}
}

const md5Upper = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex").toUpperCase();
const hashPassword = (password) => md5Upper(password);
const randomDeviceId = () =>
	crypto.randomBytes(8).toString("hex").toUpperCase().slice(0, 16);

/** 剥离 "&&&START&&&" 前缀后解析 JSON（passport 响应惯例） */
function jsonBody(text) {
	const i = (text || "").indexOf("{");
	if (i < 0) return {};
	try {
		return JSON.parse(text.slice(i));
	} catch {
		return {};
	}
}

/** 带重试的 fetch：返回 { status, text, headers, setCookie[] } */
async function request(url, { method = "GET", headers = {}, cookies = {}, body = null } = {}) {
	const cookieHeader = Object.entries(cookies)
		.filter(([, v]) => v != null && v !== "")
		.map(([k, v]) => `${k}=${v}`)
		.join("; ");
	const h = { ...headers };
	if (cookieHeader) h.Cookie = cookieHeader;
	let lastErr = null;
	for (let attempt = 0; attempt < RETRIES; attempt++) {
		try {
			const res = await fetch(url, {
				method,
				headers: h,
				body: body ? new URLSearchParams(body).toString() : undefined,
				redirect: "manual",
				signal: AbortSignal.timeout(25_000),
			});
			const text = await res.text().catch(() => "");
			const setCookie = res.headers.getSetCookie?.() ?? [];
			return { status: res.status, text, setCookie, headers: res.headers };
		} catch (e) {
			lastErr = e;
			await new Promise((r) => setTimeout(r, 1000 + attempt * 1000));
		}
	}
	throw new LoginError(`网络请求失败（${RETRIES} 次）：${lastErr?.message}`);
}

/** 收集响应 Set-Cookie 中指定名字的值（跨域匹配用） */
function cookieFrom(setCookieList, name) {
	for (const raw of setCookieList) {
		const m = raw.match(new RegExp(`^${name}=([^;]+)`));
		if (m) return m[1];
	}
	return null;
}

// ---------- 登录会话（cookie jar：内存 Map，跨步骤复用） ----------

/** sessionId → { cookies: Map, deviceId, userId } */
const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

function newSession() {
	const id = crypto.randomUUID();
	const deviceId = randomDeviceId();
	const cookies = new Map([
		["sdkVersion", SDK_VERSION],
		["deviceId", deviceId],
	]);
	const rec = { id, cookies, deviceId, userId: "", createdAt: Date.now() };
	sessions.set(id, rec);
	// 顺带清理过期会话
	for (const [k, v] of sessions) {
		if (Date.now() - v.createdAt > SESSION_TTL_MS) sessions.delete(k);
	}
	return rec;
}

function baseHeaders() {
	return { "User-Agent": UA_BASE, "Content-Type": "application/x-www-form-urlencoded" };
}

function identityHeaders(session) {
	return {
		"User-Agent": UA_APP.replace("{dev}", session.deviceId).replace("{uid}", session.userId || ""),
		"Content-Type": "application/x-www-form-urlencoded",
		Referer: "https://account.xiaomi.com/",
	};
}

/** 第一步：serviceLogin 拿 _sign / qs / callback */
async function serviceLogin(session, { withPassToken = false } = {}) {
	const cookies = { ...Object.fromEntries(session.cookies) };
	if (session.userId) cookies.userId = session.userId;
	const params = new URLSearchParams({ sid: SID_HEALTH, _json: "true" });
	const r = await request(`${ACCOUNT_HOST}/pass/serviceLogin?${params}`, {
		headers: baseHeaders(),
		cookies,
	});
	absorbCookies(session, r.setCookie);
	const j = jsonBody(r.text);
	if (!j._sign) {
		throw new LoginError(`serviceLogin 未返回 _sign（HTTP ${r.status}）`, { code: j.code });
	}
	return j;
}

function absorbCookies(session, setCookieList) {
	for (const raw of setCookieList) {
		const m = raw.match(/^([^=]+)=([^;]*)/);
		if (m && !["Expires", "Max-Age", "Path", "Domain", "Secure", "HttpOnly"].includes(m[1])) {
			session.cookies.set(m[1], m[2]);
		}
	}
}

/** 从 STS 回调响应提取 serviceToken */
function tokenFromSts(session, r) {
	return (
		cookieFrom(r.setCookie, "serviceToken") ??
		session.cookies.get("serviceToken") ??
		(() => {
			const m = (r.text || "").match(/serviceToken=([^;&"']+)/);
			return m ? m[1] : null;
		})()
	);
}

// ---------- ① 账号密码 ----------

/**
 * 提交账号密码。返回统一结果：
 *   { step: "ok", session: 凭证 }                       登录成功（无需验证）
 *   { step: "captcha", loginId, captchaUrl }            需要图片验证码
 *   { step: "2fa", loginId, verifyUrl }                 需要安全验证（官方页人工完成）
 *
 * 2FA 说明：小米已收紧 identity/* 接口的程序化触发（verifyPhone 一律 10012
 * 非法请求，含正确 identity_session/applyToken 的复刻也被拒，2026-10 实测）。
 * 官方验证页（verifyUrl）在浏览器中打开即可正常发短信/验证；用户人工完成后，
 * 服务端会话（同 context 的 serviceLogin cookie）即已认证，resume2fa 重做
 * serviceLogin 拿凭证。与 hass-xiaomi-miot 的 MiCloudNeedVerify 同模式。
 */
export async function loginPassword(username, password, { captcha = null, ick = null, loginId = null } = {}) {
	const session = loginId ? sessions.get(loginId) : null;
	if (loginId && !session) throw new LoginError("登录会话已过期，请重新开始");
	const S = session ?? newSession();

	const j1 = await serviceLogin(S);
	const fields = {
		user: username,
		hash: hashPassword(password),
		sid: SID_HEALTH,
		_json: "true",
		_sign: j1._sign,
		qs: j1.qs || `?sid=${SID_HEALTH}&_json=true`,
		callback: j1.callback || "",
	};
	const query = new URLSearchParams(fields);
	if (captcha) query.set("captCode", captcha);
	const cookies = { ...Object.fromEntries(S.cookies) };
	if (ick) cookies.ick = ick;
	const r = await request(`${ACCOUNT_HOST}/pass/serviceLoginAuth2?${query}`, {
		method: "POST",
		headers: baseHeaders(),
		cookies,
	});
	absorbCookies(S, r.setCookie);
	const j2 = jsonBody(r.text);

	if (j2.captchaUrl) {
		return { step: "captcha", loginId: S.id, captchaUrl: j2.captchaUrl };
	}
	const hasSec = typeof j2.ssecurity === "string" && j2.ssecurity.length > 4;
	if (!hasSec) {
		if (j2.notificationUrl) {
			// 把原始 notificationUrl 直接交给用户浏览器打开（服务端不预访问：
			// authStart 是一次性的，被服务端消耗后用户浏览器再开报 21305 缺参）。
			// 用户在官方页完成验证后，本会话（同账号的 passport cookie）即已认证。
			const url = j2.notificationUrl.startsWith("http")
				? j2.notificationUrl
				: ACCOUNT_HOST + j2.notificationUrl;
			return { step: "2fa", loginId: S.id, verifyUrl: url };
		}
		sessions.delete(S.id);
		throw new LoginError(j2.desc || `登录失败 code=${j2.code}`, { code: j2.code });
	}

	const creds = await completeWithSts(S, j2);
	sessions.delete(S.id);
	return { step: "ok", session: creds };
}

/**
 * 2FA 人工验证完成后的续接：重做 serviceLogin（会话已认证则返回 code=0 +
 * ssecurity/passToken/STS 地址），跟随 STS 拿 serviceToken。
 */
export async function resume2fa(loginId) {
	const S = sessions.get(loginId);
	if (!S) throw new LoginError("登录会话已过期，请重新开始");
	const j = await serviceLogin(S);
	if (j.code !== 0 || !j.ssecurity) {
		throw new LoginError(
			`尚未完成验证或验证已过期（code=${j.code} ${j.desc || ""}）——请在小米官方页面完成验证后重试`,
			{ code: j.code },
		);
	}
	const creds = await completeWithSts(S, j);
	sessions.delete(loginId);
	return { step: "ok", session: creds };
}

// ---------- ② STS 收尾 ----------

/** serviceLogin 成功响应 → 跟随 STS 拿 serviceToken，组装凭证 */
async function completeWithSts(session, j) {
	let token = null;
	if (j.location) {
		const r = await request(j.location, { headers: baseHeaders() });
		absorbCookies(session, r.setCookie);
		token = tokenFromSts(session, r);
	}
	return {
		ssecurity: j.ssecurity,
		service_token: token,
		cuser_id: j.cUserId,
		user_id: j.userId != null ? String(j.userId) : undefined,
		pass_token: j.passToken,
		sid: SID_HEALTH,
		ts: Math.floor(Date.now() / 1000),
	};
}

// ---------- ③ 二次验证（人工通道）----------
// verifyUrl 交给用户浏览器完成；resume2fa 续接（见 loginPassword 后）

// ---------- ④ 免密续期 ----------

/** pass_token 免密换票（日常续期，无需密码）。返回新凭证。 */
export async function refreshCredentials(cfg) {
	if (!cfg.pass_token || !cfg.cuser_id) {
		throw new LoginError("缺少 pass_token，请先用账号密码登录一次");
	}
	const S = newSession();
	const cookies = {
		passToken: cfg.pass_token,
		cUserId: cfg.cuser_id,
		userId: cfg.user_id ? String(cfg.user_id) : "",
		sdkVersion: SDK_VERSION,
		deviceId: S.deviceId,
	};
	const params = new URLSearchParams({ sid: SID_HEALTH, _json: "true" });
	const r = await request(`${ACCOUNT_HOST}/pass/serviceLogin?${params}`, {
		headers: baseHeaders(),
		cookies,
	});
	const j = jsonBody(r.text);
	if (j.code !== 0 || !j.location) {
		throw new LoginError(`passToken 无效或已过期（code=${j.code} ${j.desc || ""}）`, { code: j.code });
	}
	// STS 跳转不自动跟随，从 Set-Cookie 提取
	const r2 = await request(j.location, { headers: baseHeaders(), cookies });
	const token =
		cookieFrom(r2.setCookie, "serviceToken") ??
		(() => {
			const m = (r2.text || "").match(/serviceToken=([^;&"']+)/);
			return m ? m[1] : null;
		})();
	if (!token) throw new LoginError("STS 回调未返回 serviceToken");
	return {
		ssecurity: j.ssecurity,
		service_token: token,
		cuser_id: j.cUserId || cfg.cuser_id,
		user_id: j.userId != null ? String(j.userId) : cfg.user_id,
		pass_token: j.passToken || cfg.pass_token,
		sid: SID_HEALTH,
		ts: Math.floor(Date.now() / 1000),
	};
}

// ---------- 凭证落盘（与 mihealth-api config.json 同构） ----------

/** 凭证文件路径：默认 MIHEALTH_DB 同目录 config.json */
export function credentialsPath(mihealthDb) {
	return path.join(path.dirname(mihealthDb), "config.json");
}

/** 读取凭证（无文件返回 null） */
export function readCredentials(mihealthDb) {
	const p = credentialsPath(mihealthDb);
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

/** 写入凭证（保留未知字段，chmod 600；密码绝不落盘） */
export function writeCredentials(mihealthDb, session) {
	const p = credentialsPath(mihealthDb);
	let cfg = {};
	if (fs.existsSync(p)) {
		try {
			cfg = JSON.parse(fs.readFileSync(p, "utf8"));
		} catch {}
	}
	if (session.ssecurity) cfg.ssecurity = session.ssecurity;
	if (session.service_token) cfg.service_token = session.service_token;
	if (session.cuser_id) cfg.cuser_id = session.cuser_id;
	if (session.user_id) cfg.user_id = String(session.user_id);
	if (session.pass_token) cfg.pass_token = session.pass_token;
	cfg.session_at = session.ts || Math.floor(Date.now() / 1000);
	cfg.sid = session.sid || SID_HEALTH;
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
	try {
		fs.chmodSync(p, 0o600);
	} catch {}
	return cfg;
}
