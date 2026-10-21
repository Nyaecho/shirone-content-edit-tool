/**
 * 本地验证：构造 mock mihealth.db（dedup 表 + 真实字段语义）→ 启动服务 →
 * fetch 快照断言（步数日聚合/24h 序列/睡眠分晚）→ 退出码报告结果。
 * 用法：node scripts/test-mihealth.mjs（无需真实凭据/数据库）
 */
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dbPath = path.join(root, ".tmp-mihealth-test.db");
const envFile = path.join(root, ".env.mihealth-test");
const PORT = 3999;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();

// ---------- 1. mock 库（字段语义对齐 mihealth 真实数据） ----------
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const items = [];
const ins = (key, tsSec, value) =>
	items.push({ key, ts: tsSec, sid: "watch", value: JSON.stringify(value) });

for (let d = 0; d < 8; d++) {
	const dayStart = now - (7 - d) * DAY;
	// 步数：白天 8:00~22:00 每分钟增量；若窗口落在未来（凌晨跑测试）改用 now 附近的时刻
	const stepTimes = [];
	for (let h = 8; h < 22; h++)
		for (let m = 0; m < 60; m += 5) {
			const t = Math.floor((dayStart + h * HOUR + m * 60_000) / 1000);
			if (t * 1000 < now) stepTimes.push(t);
		}
	if (d === 7 && stepTimes.length === 0) {
		// 今天还没到 8 点：补 now 之前一小时内的点
		for (let back = 3600; back >= 60; back -= 300) stepTimes.push(Math.floor(now / 1000) - back);
	}
	for (const t of stepTimes) ins("steps", t, { steps: Math.round(5 + rnd() * 25) });
	for (let m = 0; m < DAY; m += 10 * 60_000) {
		const t = Math.floor((dayStart + m) / 1000);
		ins("heart_rate", t, { bpm: Math.round(55 + rnd() * 40) });
		ins("stress", t, { stress: Math.round(rnd() * 90) });
	}
	const bed = dayStart - HOUR;
	const wake = dayStart + 7 * HOUR;
	const seg = [];
	let cur = bed;
	while (cur < wake) {
		const end = Math.min(cur + (20 + rnd() * 70) * 60_000, wake);
		seg.push({ start_time: Math.floor(cur / 1000), end_time: Math.floor(end / 1000), state: [2, 3, 3, 4][Math.floor(rnd() * 4)] });
		cur = end;
	}
	ins("sleep", Math.floor(wake / 1000), {
		bedtime: Math.floor(bed / 1000),
		device_wake_up_time: Math.floor(wake / 1000),
		score: 88,
		sleep_deep_duration: 78,
		sleep_light_duration: 260,
		sleep_rem_duration: 82,
		sleep_awake_duration: 12,
		items: seg,
	});
}

if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE dedup(
  family TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, sid TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '{}', num REAL, zone_offset INTEGER, zone_name TEXT,
  update_time INTEGER, watermark INTEGER, PRIMARY KEY(family,key,ts))`);
const stmt = db.prepare("INSERT INTO dedup(family,key,ts,sid,value) VALUES('fitness',?,?,?,?)");
db.exec("BEGIN");
for (const r of items) stmt.run(r.key, r.ts, r.sid, r.value);
db.exec("COMMIT");
console.log(`[mock] ${dbPath}（${items.length} 行）`);
db.close();

fs.writeFileSync(
	envFile,
	`PORT=${PORT}\nADMIN_PASSWORD=test\nMIHEALTH_DB=${dbPath}\nMIHEALTH_DAYS=7\nDEV_MODE=0\nGITHUB_TOKEN=x\nGITHUB_OWNER=t\nGITHUB_REPO=t\n`,
);

// ---------- 2. 启动服务并断言 ----------
// 子进程 stdio 走文件而非管道：Windows 下 process.exit 时未排空管道会触发 libuv assert
const outLog = path.join(root, ".tmp-mihealth-test.out.log");
const child = spawn("node", ["--no-warnings", "--env-file=.env.mihealth-test", "server.js"], {
	cwd: root,
	stdio: ["ignore", fs.openSync(outLog, "w"), fs.openSync(outLog, "a")],
});
const readSrvLog = () => {
	try { return fs.readFileSync(outLog, "utf8"); } catch { return ""; }
};

const cleanup = async (code) => {
	child.kill();
	// 等子进程真正退出（Windows 下句柄释放是异步的，立即删库会 EPERM）
	await new Promise((r) => {
		const t = setTimeout(r, 5000);
		child.once("exit", () => { clearTimeout(t); r(); });
	});
	child.stdout?.destroy();
	child.stderr?.destroy();
	fs.rmSync(dbPath, { force: true, maxRetries: 5, retryDelay: 200 });
	fs.rmSync(`${dbPath}-wal`, { force: true, maxRetries: 5, retryDelay: 200 });
	fs.rmSync(`${dbPath}-shm`, { force: true, maxRetries: 5, retryDelay: 200 });
	fs.rmSync(envFile, { force: true });
	fs.rmSync(outLog, { force: true, maxRetries: 5, retryDelay: 200 });
	// 自然退出而非 process.exit：Windows 下强退会因未关闭的 keep-alive 句柄触发 libuv assert
	process.exitCode = code;
};

const failures = [];
const check = (name, cond, detail = "") => {
	console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond ? "" : ` — ${detail}`}`);
	if (!cond) failures.push(name);
};

try {
	let up = false;
	for (let i = 0; i < 40 && !up; i++) {
		await new Promise((r) => setTimeout(r, 250));
		try {
			up = (await fetch(`http://127.0.0.1:${PORT}/api/health/snapshot`)).ok;
		} catch {}
	}
	if (!up) {
		console.error("服务未就绪：`n", readSrvLog());
		cleanup(1);
	}

	const snap = await (await fetch(`http://127.0.0.1:${PORT}/api/health/snapshot`)).json();
	console.log("\n[snapshot] 断言：");
	check("ok=true", snap.ok === true);
	check("timezone=Asia/Shanghai", snap.timezone === "Asia/Shanghai");
	check("days=7", snap.days === 7);
	check("generatedAt 存在", typeof snap.generatedAt === "number");

	check("steps.daily 长度=7", snap.steps.daily?.length === 7, JSON.stringify(snap.steps.daily?.length));
	check("日期为 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(snap.steps.daily?.[0]?.date || ""));
	const lastDay = snap.steps.daily?.at(-1);
	const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
	check("末日=今日(站点时区)", lastDay?.date === todayStr, `${lastDay?.date} vs ${todayStr}`);
	check("steps.today>0", (snap.steps.today || 0) > 0);
	check("各日步数>0", snap.steps.daily?.every((d) => d.value > 0));
	check("today=daily 末值", snap.steps.today === lastDay?.value);
	check("deltaPct 数值|null", typeof snap.steps.deltaPct === "number" || snap.steps.deltaPct === null);

	check("heartRate min≤avg≤max", snap.heartRate.min <= snap.heartRate.avg && snap.heartRate.avg <= snap.heartRate.max);
	check("heartRate.points ≤240", (snap.heartRate.points?.length || 0) <= 240, String(snap.heartRate.points?.length));
	check("heartRate.points>0", (snap.heartRate.points?.length || 0) > 0);
	check("points t 为毫秒(>1e12)", snap.heartRate.points?.every((p) => p.t > 1e12));

	check("stress.points>0", (snap.stress.points?.length || 0) > 0);
	check("stress min≤avg≤max", snap.stress.min <= snap.stress.avg && snap.stress.avg <= snap.stress.max);

	check("sleep.nights=7", snap.sleep.nights?.length === 7, String(snap.sleep.nights?.length));
	const lastNight = snap.sleep.nights?.at(-1);
	check("末晚 totalMin≈480±120", lastNight && Math.abs(lastNight.totalMin - 480) < 120, JSON.stringify(lastNight?.totalMin));
	check("deep/light/rem 数值", [lastNight.deep, lastNight.light, lastNight.rem].every((x) => typeof x === "number"));
	check("wake>bedtime", lastNight.wake > lastNight.bedtime);
	check("stages 非空 state∈1..5 end>start", (snap.sleep.stages?.length || 0) > 0 && snap.sleep.stages.every((s) => s.state >= 1 && s.state <= 5 && s.end > s.start));
	check("stages 毫秒", snap.sleep.stages.every((s) => s.start > 1e12 && s.end > 1e12));

	check("dataThrough 存在", snap.dataThrough != null);

	const snap2 = await (await fetch(`http://127.0.0.1:${PORT}/api/health/snapshot`)).json();
	check("缓存命中（generatedAt 相同）", snap2.generatedAt === snap.generatedAt);

	const snap3 = await (await fetch(`http://127.0.0.1:${PORT}/api/health/snapshot?days=3`)).json();
	check("?days=3 生效", snap3.days === 3 && snap3.steps.daily?.length === 3);

	const posts = await fetch(`http://127.0.0.1:${PORT}/api/posts`);
	check("/api/posts 仍 401（认证边界未动）", posts.status === 401, String(posts.status));

	console.log(`\n结果：${failures.length === 0 ? "全部通过 ✅" : `${failures.length} 项失败 ❌：${failures.join("、")}`}`);
	cleanup(failures.length === 0 ? 0 : 1);
} catch (err) {
	console.error("测试异常：", err, "`n", readSrvLog());
	cleanup(1);
}
