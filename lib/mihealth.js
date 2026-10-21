/**
 * 小米运动健康数据读取（自 mihealth-api 移植，只保留博客看板所需的读取与聚合）。
 *
 * 数据库由 mihealth-api 侧 `sync.py`（服务器 cron）写入 SQLite：
 *   records(family,key,sid,ts,value,...)  原始多源行，ts 单位秒
 *   dedup(family,key,ts,...)              每分钟一行（多源/翻页重叠取最大值），查询入口
 *   value 为 JSON 文本。本模块只读打开，不参与写入（与 Python 侧 WAL 并发安全）。
 *
 * 快照契约（/api/health/snapshot 输出，字段定型，主题页据此渲染）：
 *   steps.daily[]      按站点时区日历日聚合的步数（记录 value.steps 是分钟增量，需累加）
 *   heartRate/stress   最近 24h 序列：points 降采样 ≤240 点；统计值基于全量数据计算
 *   sleep.nights[]     近 N 晚摘要（时长字段为分钟，与小米原始语义一致）
 *   sleep.stages[]     最近一夜分期段：state 2=深睡 3=浅睡 4=REM 1/5=清醒
 *   所有 t/start/end/bedtime/wake 均输出毫秒（原始记录是秒，读出时已换算）
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { config } from "./config.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------- 站点时区工具：日历日边界按站点时区切，不能按 UTC 天切 ----------

const _offsetFmt = {};
const _ymdFmt = {};

function tzOffsetMs(date, tz) {
	try {
		const dtf = (_offsetFmt[tz] ??= new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}));
		const p = {};
		for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
		const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
		return asUTC - date.getTime();
	} catch {
		return 0; // 非法时区名兜底 UTC
	}
}

/** 时刻 ms 所在站点时区日历日的 00:00（两遍求偏移，正确处理夏令时切换） */
function zonedDayStartMs(ms, tz) {
	const off1 = tzOffsetMs(new Date(ms), tz);
	const localMidnightGuess = Math.floor((ms + off1) / DAY_MS) * DAY_MS;
	const off2 = tzOffsetMs(new Date(localMidnightGuess), tz);
	return localMidnightGuess - off2;
}

/** 时刻 ms 在站点时区的日历日期串（YYYY-MM-DD） */
function ymdOf(ms, tz) {
	const f = (_ymdFmt[tz] ??= new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}));
	return f.format(new Date(ms));
}

// ---------- 只读数据库访问 ----------

const SQL_ROWS =
	"SELECT ts, sid, value FROM dedup WHERE family='fitness' AND key=? AND ts>=? AND ts<=? ORDER BY ts ASC";

let _db = null;
let _dbPath = "";

export function dbConfigured() {
	return Boolean(config.mihealth.db);
}

function getDb() {
	const p = config.mihealth.db;
	if (!p) throw new Error("MIHEALTH_DB 未配置");
	if (_db && _dbPath === p) return _db;
	if (!fs.existsSync(p)) {
		throw new Error(`健康数据库不存在: ${p}（先在 mihealth-api 侧运行 sync.py backfill）`);
	}
	_db = new DatabaseSync(p, { readOnly: true });
	_dbPath = p;
	return _db;
}

/** 读 dedup 表指定键时间窗内的行（value 已 JSON 解码，附带 _t/_sid） */
function rows(key, startSec, endSec) {
	const db = getDb();
	try {
		const out = [];
		for (const r of db.prepare(SQL_ROWS).all(key, startSec, endSec)) {
			let v;
			try {
				v = JSON.parse(r.value || "{}");
			} catch {
				v = {};
			}
			v._t = r.ts;
			v._sid = r.sid;
			out.push(v);
		}
		return out;
	} catch (err) {
		_db = null; // 库文件可能被重建/加锁，丢弃句柄下次重开
		throw err;
	}
}

// ---------- 聚合（对应 mihealth 看板的 renderSteps/renderLine/renderSleep 逻辑） ----------

/** 折线降采样：等距抽样但保留首尾点（统计值须在降采样前算） */
function downsample(points, max) {
	if (points.length <= max) return points;
	const stride = Math.ceil(points.length / max);
	const out = points.filter((_, i) => i % stride === 0);
	const last = points[points.length - 1];
	if (out[out.length - 1] !== last) out.push(last);
	return out;
}

/** 最近 24h 单字段序列：全量统计 + 降采样点位 + 覆盖到的最新秒 */
function series24h(key, field, nowMs) {
	const from = nowMs - 24 * HOUR_MS;
	const pts = [];
	for (const it of rows(key, Math.floor(from / 1000), Math.floor(nowMs / 1000))) {
		const v = Number(it[field]);
		if (Number.isFinite(v)) pts.push({ t: it._t * 1000, v });
	}
	if (!pts.length) {
		return {
			summary: { windowHours: 24, last: null, min: null, max: null, avg: null },
			points: [],
			lastTsSec: 0,
		};
	}
	const vals = pts.map((p) => p.v);
	return {
		summary: {
			windowHours: 24,
			last: pts[pts.length - 1].v,
			min: Math.min(...vals),
			max: Math.max(...vals),
			avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
		},
		points: downsample(pts, 240),
		lastTsSec: pts[pts.length - 1].t / 1000,
	};
}

/**
 * 构建博客健康页快照。
 * 站点时区取 config.siteTimezone（与博客 site.yaml 一致，日边界据此切）。
 */
export function buildSnapshot({ days } = {}) {
	const tz = config.siteTimezone;
	const n = Math.min(30, Math.max(1, days || config.mihealth.days || 7));
	const now = Date.now();
	const todayStart = zonedDayStartMs(now, tz);
	const firstDay = todayStart - (n - 1) * DAY_MS;

	// —— 步数：按站点时区日历日累加，缺失日补 0（柱状图日期连续）——
	const byDay = new Map();
	for (let d = 0; d < n; d++) {
		const dayStart = firstDay + d * DAY_MS;
		byDay.set(ymdOf(dayStart, tz), { date: ymdOf(dayStart, tz), value: 0 });
	}
	let stepsLastSec = 0;
	for (const it of rows("steps", Math.floor(firstDay / 1000), Math.floor(now / 1000))) {
		const slot = byDay.get(ymdOf(it._t * 1000, tz));
		if (slot) slot.value += Number(it.steps) || 0;
		if (it._t > stepsLastSec) stepsLastSec = it._t;
	}
	const daily = [...byDay.values()].map((d) => ({ date: d.date, value: Math.round(d.value) }));
	const today = daily.length ? daily[daily.length - 1].value : 0;
	const yesterday = daily.length > 1 ? daily[daily.length - 2].value : null;
	const deltaPct =
		yesterday && yesterday > 0
			? Math.round(((today - yesterday) / yesterday) * 1000) / 10
			: null;

	// —— 心率 / 压力：最近 24h ——
	const heart = series24h("heart_rate", "bpm", now);
	const stress = series24h("stress", "stress", now);

	// —— 睡眠：按“清醒日”分晚；每天保留全部会话（夜睡 + 午睡），
	// 主会话（时长最长，含分期 items）用于摘要/分期，泳道上逐段展示 ——
	const sleepRows = rows("sleep", Math.floor((firstDay - DAY_MS) / 1000), Math.floor(now / 1000));
	const nightsByDay = new Map();
	for (const s of sleepRows) {
		const wakeMs = (s.device_wake_up_time || s.bedtime || s._t) * 1000;
		const day = ymdOf(wakeMs, tz);
		if (!nightsByDay.has(day)) nightsByDay.set(day, []);
		nightsByDay.get(day).push(s);
	}
	const sessionsOf = (list) =>
		list
			.map((s) => ({
				bedtime: (s.bedtime || 0) * 1000,
				wake: (s.device_wake_up_time || 0) * 1000,
			}))
			.filter((x) => x.wake > x.bedtime);
	const mainOf = (list) =>
		list.reduce((best, s) => {
			const dur = (s.device_wake_up_time || 0) - (s.bedtime || 0);
			const bestDur = (best?.device_wake_up_time || 0) - (best?.bedtime || 0);
			return !best || dur > bestDur ? s : best;
		}, null);
	const nights = [...nightsByDay.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.slice(-n)
		.map(([day, list]) => {
			const main = mainOf(list);
			return {
				date: day,
				bedtime: (main.bedtime || 0) * 1000,
				wake: (main.device_wake_up_time || 0) * 1000,
				totalMin: Math.round(((main.device_wake_up_time || 0) - (main.bedtime || 0)) / 60),
				deep: main.sleep_deep_duration ?? null,
				light: main.sleep_light_duration ?? null,
				rem: main.sleep_rem_duration ?? null,
				awake: main.sleep_awake_duration ?? null,
				score: main.score ?? null,
				sessions: sessionsOf(list),
			};
		});
	// 最近一天主会话的分期段（end>start 过滤零长段，与 mihealth 看板一致）
	const lastList = [...nightsByDay.values()].sort((a, b) => {
		const am = a[0]?._t || 0;
		const bm = b[0]?._t || 0;
		return am - bm;
	}).at(-1);
	const lastNight = lastList ? mainOf(lastList) : null;
	const stages = ((lastNight && lastNight.items) || [])
		.filter((i) => (i.end_time || 0) > (i.start_time || 0))
		.map((i) => ({ start: i.start_time * 1000, end: i.end_time * 1000, state: i.state }));

	// —— 数据覆盖到的最新时刻（页面“更新至”标注；任一键有新数据即算）——
	const lastTsSec = Math.max(0, stepsLastSec, heart.lastTsSec, stress.lastTsSec);

	return {
		ok: true,
		generatedAt: now,
		timezone: tz,
		days: n,
		dataThrough: lastTsSec > 0 ? lastTsSec * 1000 : null,
		steps: { today, yesterday, deltaPct, daily },
		heartRate: { ...heart.summary, points: heart.points },
		stress: { ...stress.summary, points: stress.points },
		sleep: { nights, stages },
	};
}

/** 各数据键的行数与覆盖区间（/api/health/status 运维排查用） */
export function describeDb() {
	const db = getDb();
	const keys = ["steps", "heart_rate", "stress", "sleep"];
	const out = {};
	const stmt = db.prepare(
		"SELECT COUNT(*) c, MIN(ts) lo, MAX(ts) hi FROM dedup WHERE family='fitness' AND key=?",
	);
	for (const k of keys) {
		const r = stmt.get(k);
		out[k] = { count: r.c, first: r.lo ?? null, last: r.hi ?? null };
	}
	return out;
}
