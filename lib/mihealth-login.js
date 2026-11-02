/**
 * 小米健康凭证读写 + 自动续期支撑。
 *
 * 职责（现行语义）：
 *   - 凭证落盘：credentialsPath / readCredentials / writeCredentials——
 *     MIHEALTH_DB 同目录 config.json（600），与 mihealth-api 的库完全同构；
 *   - 免密续期：refreshCredentials 用 passToken 走 serviceLogin → STS 换新
 *     serviceToken（mihealth-sync 的 startAutoRenew 每日调度，401 自愈亦复用）。
 *
 * 续期路径对齐点（实测坑位，与服务端行为一一对应，仍然生效）：
 * - 响应体带 "&&&START&&&" 前缀，必须剥离后再 JSON 解析；
 * - cookie 必须带 sdkVersion=accountsdk-18.8.15 与 deviceId，UA 要像 App；
 * - serviceLogin 必须带 passToken cookie 发一次才返回 code=0 + STS location，
 *   STS 跳转不要自动跟随（从 Set-Cookie 提取 serviceToken）。
 *
 * 历史注记：完整登录状态机（密码登录 / 图片验证码 / 2FA 人工通道）已随登录
 * 向导下线整体移除——2FA 程序化触发被小米接口收紧（verifyPhone 一律 10012，
 * 含正确 identity_session/applyToken 的复刻也被拒，2026-10 实测）；如需恢复
 * 请翻仓库历史。
 *
 * 安全：凭证（ssecurity/serviceToken/passToken）只落 MIHEALTH_DB 同目录
 * config.json（600）；密码不经手本模块。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ACCOUNT_HOST = "https://account.xiaomi.com";
const SID_HEALTH = "miothealth";
const SDK_VERSION = "accountsdk-18.8.15";
const UA_BASE = "XiaomiHealthApi-ABCDE APP/com.xiaomi.mihome APPV/10.5.201";

/** 每次请求的最大重试（passport/STS 直连偶发超时） */
const RETRIES = 3;

class LoginError extends Error {
	constructor(message, { code = null } = {}) {
		super(message);
		this.code = code;
	}
}

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

function baseHeaders() {
	return { "User-Agent": UA_BASE, "Content-Type": "application/x-www-form-urlencoded" };
}

/** 一次性续期会话：每次调用生成 fresh deviceId（cookie 必须带 deviceId） */
function newSession() {
	return { deviceId: randomDeviceId() };
}

// ---------- 免密续期（每日；mihealth-sync 401 自愈复用同一函数） ----------

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
function credentialsPath(mihealthDb) {
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
