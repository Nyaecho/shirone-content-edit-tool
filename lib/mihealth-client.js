/**
 * 小米运动健康 API 客户端 —— 自 mihealth-api mihealth_client.py 完整移植（Node 零依赖）。
 *
 * 请求签名与加密（与客户端行为一致）：
 *   nonce      = b64( random(8B) | int32_BE(minutes_since_epoch) )
 *   sessionKey = b64( SHA256( b64dec(ssecurity) | b64dec(nonce) ) )   → RC4-drop1024 密钥
 *   加密端点   ：参数明文排序 → 插入 rc4_hash__（SHA1 签名）→ 逐值 RC4 加密再 b64
 *               → signature = SHA1(method & path & 加密kv & sessionKey)
 *   明文端点   ：signature = HMAC-SHA256( method & skey & nonce & kv , skey )
 *   解密响应   ：RC4(sessionKey).crypt( b64dec(body) )
 *   Cookie     ：cUserId / serviceToken / locale=zh_cn
 *
 * 翻页要点（与上游一致的坑位）：
 *   - 游标字段是 snake_case `next_key`（camelCase 被服务端静默忽略）；
 *   - startTime=0 + next_key 会冻结游标，窗口查询用「最近 24h 起点 + 回溯翻页」；
 *   - 水位流 waterMark=0 是 seek（返回首个水位不带数据），0 表示流头不可覆盖游标。
 */
import crypto from "node:crypto";

const HOSTS = { cn: "https://hlth.io.mi.com", abroad: "https://region.hlth.io.mi.com" };
const PREFIX = "/app/v1/";
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ApiError extends Error {}
export class AuthError extends ApiError {}

const b64e = (b) => Buffer.from(b).toString("base64");
const b64d = (s) => Buffer.from(s, "base64");
const sha1B64 = (items) =>
	b64e(crypto.createHash("sha1").update(items.join("&"), "utf8").digest());
const hmacSha256B64 = (text, keyB64) =>
	b64e(crypto.createHmac("sha256", b64d(keyB64)).update(text, "utf8").digest());

/** RC4（丢弃前 1024 字节，与客户端 o0l 一致） */
class RC4 {
	constructor(keyBytes, drop = 1024) {
		const s = new Uint8Array(256);
		for (let i = 0; i < 256; i++) s[i] = i;
		let j = 0;
		for (let i = 0; i < 256; i++) {
			j = (j + s[i] + keyBytes[i % keyBytes.length]) & 0xff;
			[s[i], s[j]] = [s[j], s[i]];
		}
		this.s = s;
		this.i = 0;
		this.j = 0;
		// drop 阶段只推进状态
		for (let n = 0; n < drop; n++) {
			this.i = (this.i + 1) & 0xff;
			this.j = (this.j + this.s[this.i]) & 0xff;
			[this.s[this.i], this.s[this.j]] = [this.s[this.j], this.s[this.i]];
		}
	}
	crypt(data) {
		const out = Buffer.alloc(data.length);
		for (let n = 0; n < data.length; n++) {
			this.i = (this.i + 1) & 0xff;
			this.j = (this.j + this.s[this.i]) & 0xff;
			[this.s[this.i], this.s[this.j]] = [this.s[this.j], this.s[this.i]];
			out[n] = data[n] ^ this.s[(this.s[this.i] + this.s[this.j]) & 0xff];
		}
		return out;
	}
}

function genNonce(timeDiffMs = 0) {
	const rand8 = crypto.randomBytes(8);
	const minutes = Math.floor((Date.now() + timeDiffMs) / 60000);
	const minBuf = Buffer.alloc(4);
	minBuf.writeInt32BE(minutes);
	return b64e(Buffer.concat([rand8, minBuf]));
}

function sessionKey(ssecurity, nonce) {
	return b64e(crypto.createHash("sha256").update(Buffer.concat([b64d(ssecurity), b64d(nonce)])).digest());
}

function pathOf(path) {
	try {
		return new URL(path, "https://x").pathname || path;
	} catch {
		return path;
	}
}

function cleanParams(params) {
	const out = {};
	for (const [k, v] of Object.entries(params || {})) {
		if (k && v !== "" && v != null) out[k] = String(v);
	}
	return out;
}

function kvItems(map) {
	return Object.keys(map)
		.sort()
		.map((k) => `${k}=${map[k]}`);
}

/** 加密端点签名（encryptResponse=true，fitness 数据接口） */
function signedEncrypted(method, path, params, nonce, security) {
	const skey = sessionKey(security, nonce);
	const plain = cleanParams(params);
	const p = pathOf(path);
	const rc4Hash = sha1B64([method.toUpperCase(), p, ...kvItems(plain), skey]);
	plain["rc4_hash__"] = rc4Hash;
	const rc4 = new RC4(b64d(skey));
	const enc = {};
	for (const k of Object.keys(plain).sort()) {
		enc[k] = b64e(rc4.crypt(Buffer.from(plain[k], "utf8")));
	}
	const sig = sha1B64([method.toUpperCase(), p, ...kvItems(enc), skey]);
	return { ...enc, signature: sig, _nonce: nonce };
}

/** 明文端点签名（HMAC） */
function signedPlain(method, path, params, nonce, security) {
	const skey = sessionKey(security, nonce);
	const items = [];
	if (method) items.push(method.toUpperCase());
	items.push(skey, nonce);
	const clean = cleanParams(params);
	items.push(...(Object.keys(clean).length ? kvItems(clean) : ["data="]));
	return { ...clean, signature: hmacSha256B64(items.join("&"), skey), _nonce: nonce };
}

function decryptResponse(bodyB64, nonce, security) {
	return new RC4(b64d(sessionKey(security, nonce)))
		.crypt(b64d(bodyB64))
		.toString("utf8");
}

/** 跨页/多源去重：同 (sid,time) 保留标量值更大的一条 */
export const SCALAR_FIELDS = {
	steps: ["steps"],
	calories: ["calories"],
	heart_rate: ["bpm", "heart_rate"],
	spo2: ["spo2"],
	stress: ["stress", "stress_value"],
	vo2_max: ["vo2_max"],
	pai: ["daily_pai", "pai", "value"],
	weight: ["weight"],
	energy: ["energy"],
	sleep: [],
	goal: [],
	sport: [],
};

function canonicalNumber(key, item) {
	for (const f of SCALAR_FIELDS[key] || []) {
		const v = item[f];
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return null;
}

export function dedupItems(items, key = null) {
	const byT = new Map();
	for (const it of items) {
		const t = it._t ?? it.time;
		if (t == null) continue;
		const cur = byT.get(t);
		if (!cur) {
			byT.set(t, it);
			continue;
		}
		const a = canonicalNumber(key, it);
		const b = canonicalNumber(key, cur);
		if (b == null || (a != null && a > b)) byT.set(t, it);
	}
	return [...byT.values()];
}

const compact = (obj) => JSON.stringify(obj);

const j = (obj) => JSON.stringify(obj);

export class MiHealthClient {
	constructor({ ssecurity, service_token, cuser_id, region = "cn", host = null, timeoutMs = 25_000, maxRetries = 3, minIntervalMs = 0, onAuthError = null }) {
		this.security = ssecurity;
		this.serviceToken = service_token;
		this.cuser = cuser_id;
		this.base = (host || HOSTS[region] || HOSTS.cn).replace(/\/$/, "");
		this.timeoutMs = timeoutMs;
		this.maxRetries = maxRetries;
		this.minIntervalMs = minIntervalMs;
		this.onAuthError = onAuthError;
		this._last = 0;
	}

	reloadCredentials({ ssecurity, service_token, cuser_id }) {
		if (ssecurity) this.security = ssecurity;
		if (service_token) this.serviceToken = service_token;
		if (cuser_id) this.cuser = cuser_id;
	}

	async _throttle() {
		if (this.minIntervalMs <= 0) return;
		const wait = this.minIntervalMs - (Date.now() - this._last);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this._last = Date.now();
	}

	async _send(method, url, q) {
		let lastErr = null;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			await this._throttle();
			try {
				// 与上游一致：GET 参数走 query，POST 走 form body
				const qs = new URLSearchParams(q).toString();
				const isGet = method.toUpperCase() === "GET";
				const fullUrl = isGet ? `${url}?${qs}` : url;
				const res = await fetch(fullUrl, {
					method: method.toUpperCase(),
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Cookie: `cUserId=${this.cuser}; serviceToken=${this.serviceToken}; locale=zh_cn`,
					},
					body: isGet ? undefined : qs,
					signal: AbortSignal.timeout(this.timeoutMs),
					redirect: "manual",
				});
				if (RETRY_STATUS.has(res.status) && attempt < this.maxRetries) {
					await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000 + Math.random() * 1000, 8000)));
					continue;
				}
				return { status: res.status, text: await res.text().catch(() => "") };
			} catch (e) {
				lastErr = e;
			}
			if (attempt < this.maxRetries) {
				await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000 + Math.random() * 1000, 8000)));
			}
		}
		throw new ApiError(`request failed after ${this.maxRetries + 1} tries: ${lastErr?.message}`);
	}

	/** 单次签名调用；返回解密后的 JSON。鉴权失败走 onAuthError 自愈一次。 */
	async call(subpath, params, { method = "GET", decrypt = true, prefix = PREFIX } = {}) {
		let refreshed = false;
		for (;;) {
			const nonce = genNonce();
			const q = signedEncrypted(method, prefix + subpath, params, nonce, this.security);
			const r = await this._send(method, this.base + prefix + subpath, q);
			let authProblem = r.status === 401 || r.status === 403;
			let data = null;
			if (!authProblem) {
				if (r.status >= 400) throw new ApiError(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
				if (!decrypt) return r.text;
				try {
					data = JSON.parse(decryptResponse(r.text, nonce, this.security));
				} catch {
					try {
						data = JSON.parse(r.text);
					} catch {
						throw new ApiError(`undecodable response: ${r.text.slice(0, 200)}`);
					}
				}
				const code = data?.code;
				if (code === 2 || (typeof code === "number" && String(data?.message || "").toLowerCase().includes("auth"))) {
					authProblem = true;
				}
			}
			if (!authProblem) return data;
			const why = data == null ? `HTTP ${r.status}` : `code=${data?.code}`;
			if (!refreshed && typeof this.onAuthError === "function") {
				refreshed = true;
				let ok = false;
				try {
					ok = Boolean(await this.onAuthError(this, why));
				} catch {
					ok = false;
				}
				if (ok) continue;
			}
			throw new AuthError(`auth failed (${why})`);
		}
	}

	// ---------- 翻页（时间窗） ----------

	async _pagedAll(fetchPage, listField, startMs, endMs, maxPages, { stopBelowStart = true, onPage = null } = {}) {
		let items = [];
		let nk = null;
		for (let page = 0; page < maxPages; page++) {
			const res = (await fetchPage(nk))?.result ?? {};
			const batch = res[listField] ?? [];
			for (const it of batch) if (it._t == null) it._t = it.time;
			const kept = batch.filter(
				(it) => (it.time ?? 0) * 1000 >= startMs && (it.time ?? 0) * 1000 <= endMs,
			);
			if (onPage) onPage(kept, nk, page);
			else items = items.concat(kept);
			nk = res.next_key;
			if (!res.has_more || !nk) return { items, more: false };
			if (stopBelowStart && batch.length && Math.max(...batch.map((x) => x.time ?? 0)) * 1000 < startMs) {
				return { items, more: false };
			}
		}
		return { items, more: true };
	}

	/** 拉一个 fitness 键的时间窗（或全历史）全量，逐页回调流式处理 */
	async getFitnessDataAll(key, startMs, endMs, { maxPages = 200, onPage = null } = {}) {
		const apiStart = Math.max(startMs, endMs - 86_400_000);
		const { items, more } = await this._pagedAll(
			(nk) => this.call("data/get_fitness_data_by_time", {
				data: j({ key, startTime: apiStart, endTime: endMs, reverse: true, next_key: nk }),
			}),
			"data_list",
			startMs,
			endMs,
			maxPages,
			{ stopBelowStart: startMs > 0, onPage },
		);
		return { dataList: dedupItems(items, key), hasMore: more };
	}

	// ---------- 水位增量 ----------

	async getMaxWatermark(type = 0) {
		const r = await this.call("data/get_max_watermark", { data: j({ type }) });
		return r?.result?.watermark ?? 0;
	}

	/** 走一个 family 的前向水位流；返回 { items, lastWm, hasMore } */
	async syncByWatermark(subpath, listField, startWm, { maxPages = 500, onPage = null } = {}) {
		let items = [];
		let wm = startWm;
		let lastGood = startWm;
		for (let page = 0; page < maxPages; page++) {
			const res = (await this.call(subpath, { data: j({ waterMark: wm }) }))?.result ?? {};
			const batch = res[listField] ?? [];
			for (const it of batch) if (it._t == null) it._t = it.time;
			items = items.concat(batch);
			const nwm = res.watermark ?? 0;
			if (!res.has_more || !nwm || nwm === wm) {
				return {
					items: dedupItems(items),
					lastWm: lastGood || wm,
					hasMore: Boolean(res.has_more),
				};
			}
			lastGood = nwm;
			if (onPage) onPage(batch, nwm, page);
			wm = nwm;
		}
		return { items: dedupItems(items), lastWm: lastGood, hasMore: true };
	}

	/** 时间窗补拉（增量时修复断档）：最近 hours 小时逐键拉齐 */
	async windowTopupKeys(keys, hours, onPage) {
		const now = Date.now();
		const start = now - hours * 3_600_000;
		for (const key of keys) {
			await this.getFitnessDataAll(key, start, now, { maxPages: 200, onPage });
		}
	}
}
