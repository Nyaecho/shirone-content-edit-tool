/**
 * 健康数据同步编排器 —— 自 mihealth-api sync.py/store.py 移植（Node）。
 *
 * 职责：
 *   - SQLite 建库（records + dedup + sync_state，与 mihealth-api 同构）；
 *   - backfill：时间窗翻页全量回填（逐页落库，断点可续）；
 *   - incremental：水位流增量 + 最近 72h 时间窗补拉；
 *   - 401 自愈：调用免密续期（mihealth-login）换新凭证后重试当次请求；
 *   - 内置每小时定时器（管理平台进程内，替代 cron）。
 *
 * 与 mihealth-api 的库**完全兼容**：同样的表结构与 dedup 物化规则，
 * 已有库可直接被本模块接管；反之亦然。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MiHealthClient, AuthError } from "./mihealth-client.js";
import { readCredentials, writeCredentials, refreshCredentials } from "./mihealth-login.js";
import { config } from "./config.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 博客快照所需的数据键（17 键全集的实用子集；加键只需在此追加） */
export const SYNC_KEYS = [
	"steps",
	"sleep",
	"heart_rate",
	"stress",
	"spo2",
	"calories",
];

const WM_FAMILIES = {
	fitness: { sub: "data/get_fitness_data_by_watermark", field: "data_list", type: 0 },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records(
  family TEXT NOT NULL,
  key TEXT NOT NULL,
  sid TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  value TEXT NOT NULL DEFAULT '{}',
  num REAL,
  zone_offset INTEGER,
  zone_name TEXT,
  update_time INTEGER,
  watermark INTEGER,
  PRIMARY KEY(family, key, sid, ts)
);
CREATE INDEX IF NOT EXISTS idx_records_ts ON records(family, key, ts);
CREATE TABLE IF NOT EXISTS dedup(
  family TEXT NOT NULL,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sid TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '{}',
  num REAL,
  zone_offset INTEGER,
  zone_name TEXT,
  update_time INTEGER,
  watermark INTEGER,
  PRIMARY KEY(family, key, ts)
);
CREATE INDEX IF NOT EXISTS idx_dedup_ts ON dedup(family, key, ts);
CREATE TABLE IF NOT EXISTS sync_state(
  name TEXT PRIMARY KEY,
  last_ts INTEGER,
  last_wm INTEGER,
  updated_at INTEGER
);
`;

const SCALAR_FIELDS = {
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
};

function canonicalNum(key, vobj) {
	for (const f of SCALAR_FIELDS[key] || []) {
		const v = vobj[f];
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return null;
}

class SyncStore {
	constructor(dbPath) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL");
		this.db.exec("PRAGMA synchronous=NORMAL");
		this.db.exec(SCHEMA);
		this.path = dbPath;
	}

	upsert(family, key, items) {
		let n = 0;
		const ins = this.db.prepare(
			"INSERT OR REPLACE INTO records(family,key,sid,ts,value,num,zone_offset,zone_name,update_time,watermark) VALUES(?,?,?,?,?,?,?,?,?,?)",
		);
		const del = this.db.prepare("DELETE FROM dedup WHERE family=? AND key=? AND ts BETWEEN ? AND ?");
		const put = this.db.prepare(
			`INSERT INTO dedup(family,key,ts,sid,value,num,zone_offset,zone_name,update_time,watermark)
			 SELECT family,key,ts,sid,value,num,zone_offset,zone_name,update_time,watermark FROM (
			   SELECT *, ROW_NUMBER() OVER (PARTITION BY family,key,ts ORDER BY (num IS NULL), num DESC, rowid) AS _rn
			   FROM records WHERE family=? AND key=? AND ts BETWEEN ? AND ?
			 ) WHERE _rn=1`,
		);
		const spans = new Map();
		this.db.exec("BEGIN");
		try {
			for (const it of items) {
				const ts = it.time ?? it._t;
				if (ts == null) continue;
				let vobj = {};
				try {
					vobj = JSON.parse(it.value || "{}");
				} catch {}
				ins.run(
					family,
					key,
					String(it.sid ?? ""),
					Number(ts),
					it.value || "{}",
					canonicalNum(key, vobj),
					it.zone_offset ?? null,
					it.zone_name ?? null,
					it.update_time ?? null,
					it.watermark ?? null,
				);
				n++;
				const cur = spans.get(key) ?? [ts, ts];
				spans.set(key, [Math.min(cur[0], ts), Math.max(cur[1], ts)]);
			}
			for (const [k, [lo, hi]] of spans) {
				del.run(family, k, lo, hi);
				put.run(family, k, lo, hi);
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
		return n;
	}

	getState(name, field) {
		const r = this.db.prepare(`SELECT ${field} FROM sync_state WHERE name=?`).get(name);
		return r?.[field] ?? null;
	}

	setState(name, { lastTs = null, lastWm = null }) {
		const cur = this.db.prepare("SELECT last_ts,last_wm FROM sync_state WHERE name=?").get(name);
		if (cur) {
			this.db
				.prepare("UPDATE sync_state SET last_ts=COALESCE(?,last_ts), last_wm=COALESCE(?,last_wm), updated_at=? WHERE name=?")
				.run(lastTs, lastWm, Date.now(), name);
		} else {
			this.db
				.prepare("INSERT INTO sync_state(name,last_ts,last_wm,updated_at) VALUES(?,?,?,?)")
				.run(name, lastTs, lastWm, Date.now());
		}
	}

	close() {
		try {
			this.db.close();
		} catch {}
	}
}

/**
 * 同步器：凭证自动从 MIHEALTH_DB 同目录 config.json 读取；
 * 401 时自动免密续期写回并重试。
 */
export class HealthSyncer {
	constructor(dbPath) {
		this.dbPath = dbPath;
		this.store = null;
		this.client = null;
		this.running = false;
		this.lastResult = null;
	}

	get credentialsPath() {
		return path.join(path.dirname(this.dbPath), "config.json");
	}

	_open() {
		if (!this.store) this.store = new SyncStore(this.dbPath);
	}

	_newClient() {
		const cfg = readCredentials(this.dbPath);
		if (!cfg?.ssecurity || !cfg?.service_token) {
			throw new Error("凭证未部署——请先在管理平台「健康凭证」里上传或登录");
		}
		return new MiHealthClient({
			ssecurity: cfg.ssecurity,
			service_token: cfg.service_token,
			cuser_id: cfg.cuser_id,
			minIntervalMs: 400,
			onAuthError: async (client, why) => {
				// 401 自愈：免密续期 → 写回 config.json → 热更新客户端凭证
				try {
					console.log(`[mi-sync] auth error (${why}) -> 免密续期`);
					const fresh = await refreshCredentials(cfg);
					writeCredentials(this.dbPath, fresh);
					client.reloadCredentials(fresh);
					console.log("[mi-sync] 凭证已续期并写回");
					return true;
				} catch (e) {
					console.warn(`[mi-sync] 续期失败: ${e.message}`);
					return false;
				}
			},
		});
	}

	/** 全量回填（逐页落库，可中断续跑） */
	async backfill({ days = 0 } = {}) {
		this._open();
		const c = this._newClient();
		const now = Date.now();
		const start = days > 0 ? now - days * DAY_MS : 0;
		let total = 0;
		for (const key of SYNC_KEYS) {
			const stats = { rows: 0 };
			await c.getFitnessDataAll(key, start, now, {
				maxPages: 400,
				onPage: (batch) => {
					stats.rows += this.store.upsert("fitness", key, batch);
				},
			});
			total += stats.rows;
			console.log(`[mi-sync] backfill ${key}: ${stats.rows} rows`);
		}
		this.lastResult = { mode: "backfill", rows: total, at: Date.now() };
		return total;
	}

	/** 增量：水位流 + 72h 时间窗补拉（与上游 incremental 同策略） */
	async incremental() {
		this._open();
		const c = this._newClient();
		let total = 0;

		// 1) fitness 水位流
		const { sub, field } = WM_FAMILIES.fitness;
		let last = this.store.getState("wm_fitness", "last_wm");
		if (!last) {
			last = await c.getMaxWatermark(0);
			this.store.setState("wm_fitness", { lastWm: last });
			console.log(`[mi-sync] wm_fitness 游标初始化: ${last}`);
		} else {
			const stats = { rows: 0 };
			const r = await c.syncByWatermark(sub, field, last, {
				maxPages: 100,
				onPage: (batch) => {
					const byKey = new Map();
					for (const it of batch) {
						const k = it.key || "unknown";
						if (!byKey.has(k)) byKey.set(k, []);
						byKey.get(k).push(it);
					}
					for (const [k, rows] of byKey) stats.rows += this.store.upsert("fitness", k, rows);
				},
			});
			this.store.setState("wm_fitness", { lastWm: r.lastWm });
			total += stats.rows;
			console.log(`[mi-sync] wm_fitness: ${stats.rows} rows, cursor=${r.lastWm}`);
		}

		// 2) 最近 72h 时间窗补拉（修复断档）
		for (const key of SYNC_KEYS) {
			const stats = { rows: 0 };
			await c.getFitnessDataAll(key, Date.now() - 72 * HOUR_MS, Date.now(), {
				maxPages: 50,
				onPage: (batch) => {
					stats.rows += this.store.upsert("fitness", key, batch);
				},
			});
			total += stats.rows;
		}
		console.log(`[mi-sync] incremental done: ${total} rows`);
		this.lastResult = { mode: "incremental", rows: total, at: Date.now() };
		return total;
	}

	/** 后台跑一次（互斥；进行中时直接返回状态） */
	async run(mode = "incremental") {
		if (this.running) return { running: true, lastResult: this.lastResult };
		this.running = true;
		try {
			if (mode === "backfill") await this.backfill();
			else await this.incremental();
			return { running: false, lastResult: this.lastResult };
		} catch (e) {
			this.lastResult = { mode, error: e.message, at: Date.now() };
			console.error(`[mi-sync] ${mode} failed:`, e.message);
			return { running: false, lastResult: this.lastResult };
		} finally {
			this.running = false;
		}
	}
}

// ---------- 进程内定时器（替代 cron） ----------

let timer = null;
let syncerSingleton = null;

export function getSyncer() {
	if (!syncerSingleton) {
		syncerSingleton = new HealthSyncer(config.mihealth.db);
	}
	return syncerSingleton;
}

/** 启动每小时自动增量（管理平台启动时调用一次） */
export function startAutoSync() {
	if (timer) return;
	const intervalMs = Number(config.mihealth.syncIntervalMs || 60 * 60 * 1000);
	const s = getSyncer();
	// 首次延迟 1 分钟（避开启动高峰），之后每小时
	timer = setInterval(
		() => {
			s.run("incremental").catch(() => {});
		},
		intervalMs,
	);
	timer.unref();
	setTimeout(() => {
		s.run("incremental").catch(() => {});
	}, 60_000).unref();
	console.log(`[mi-sync] 自动同步已启动（每 ${Math.round(intervalMs / 60000)} 分钟）`);
}

export function stopAutoSync() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

// ---------- 凭证主动续期（替代写作台手动「免密续期」按钮） ----------

/**
 * 续期状态（供警示点接口读取）：
 * - lastOkAt：最近一次续期成功时间戳
 * - lastError / lastErrorAt：最近一次续期失败（原因 + 时间）
 */
const renewState = { lastOkAt: null, lastError: null, lastErrorAt: null };

export function renewStatus() {
	return { ...renewState };
}

async function renewOnce() {
	const cfg = readCredentials(config.mihealth.db);
	if (!cfg) return; // 凭证未部署（纯配置文件方式：由运维放置 config.json）
	// 距上次会话激活超过 14 天才续（pass_token 有效期约 1~2 个月，避免频繁刷新）
	const sessionAt = Number(cfg.session_at ?? cfg.ts ?? 0);
	const ageDays = (Date.now() / 1000 - sessionAt) / 86400;
	if (ageDays < 14) return;
	try {
		const fresh = await refreshCredentials(cfg);
		writeCredentials(config.mihealth.db, fresh);
		renewState.lastOkAt = Date.now();
		renewState.lastError = null;
		renewState.lastErrorAt = null;
		console.log("[mi-renew] 凭证已主动续期并写回 config.json");
	} catch (e) {
		renewState.lastError = e.message || String(e);
		renewState.lastErrorAt = Date.now();
		console.warn(`[mi-renew] 主动续期失败: ${renewState.lastError}（pass_token 可能已失效，需运维重新生成 config.json）`);
	}
}

let renewTimer = null;

/** 启动每日主动续期检查（与同步定时器解耦：续期失败不影响数据拉取重试） */
export function startAutoRenew() {
	if (renewTimer) return;
	renewTimer = setInterval(renewOnce, 24 * 60 * 60 * 1000);
	renewTimer.unref();
	setTimeout(renewOnce, 5 * 60_000).unref(); // 启动 5 分钟后首查
	console.log("[mi-renew] 凭证自动续期已启动（每日检查，会话超 14 天触发）");
}

export function stopAutoRenew() {
	if (renewTimer) {
		clearInterval(renewTimer);
		renewTimer = null;
	}
}
