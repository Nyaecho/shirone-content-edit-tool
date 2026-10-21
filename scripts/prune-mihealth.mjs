/**
 * 健康数据库清理脚本：删除 N 天前的行，控制库体积。
 *
 * 背景：mihealth-api（上游第三方仓库，保持原样不改）的 sync.py 只增不删，
 * 全量回填后库可达百 MB。博客只需要近 N 天（MIHEALTH_DAYS），本脚本在
 * cron 里跟在 sync 后面做窗口清理；云端始终保留全量历史，需要时用
 * `sync.py backfill --days N` 随时拉回。
 *
 * 行为：
 *   - 删除 records 与 dedup 两表中 ts < cutoff 的行（同 (family,key) 索引顺序删）；
 *   - 行删除始终生效；VACUUM 收缩文件需要独占访问——管理平台常驻只读连接
 *     时会失败，属预期（行已删，空间在下次成功 VACUUM 时回收）；
 *   - 退出码：0 正常；1 参数/文件错误。
 *
 * cron 用法（跟在增量同步之后）：
 *   0 * * * *  cd /srv/mihealth-api && .venv/bin/python sync.py incremental \
 *              && node /srv/shirone-admin/scripts/prune-mihealth.mjs --keep-days 7
 *
 * 本地用法：node scripts/prune-mihealth.mjs --db path/to/mihealth.db --keep-days 7
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : fallback;
};
const keepDays = Number(argOf("keep-days", "7"));
const dbPath = path.resolve(argOf("db", ""));

if (!dbPath || !Number.isFinite(keepDays) || keepDays < 1) {
	console.error("用法: node prune-mihealth.mjs --db <mihealth.db 路径> [--keep-days 7]");
	process.exit(1);
}
if (!fs.existsSync(dbPath)) {
	console.error(`数据库不存在: ${dbPath}`);
	process.exit(1);
}

const cutoffSec = Math.floor((Date.now() - keepDays * 86_400_000) / 1000);
const cutoffHuman = new Date(cutoffSec * 1000).toLocaleString("zh-CN");

const db = new DatabaseSync(dbPath);
let removed = 0;
const pairs = db
	.prepare("SELECT DISTINCT family, key FROM records")
	.all();
for (const { family, key } of pairs) {
	removed += db
		.prepare("DELETE FROM records WHERE family=? AND key=? AND ts<?")
		.run(family, key, cutoffSec).changes;
	db.prepare("DELETE FROM dedup WHERE family=? AND key=? AND ts<?").run(
		family,
		key,
		cutoffSec,
	);
}
db.close();

let vacuumed = false;
try {
	const db2 = new DatabaseSync(dbPath);
	db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	db2.exec("VACUUM");
	db2.close();
	vacuumed = true;
} catch {
	// 管理平台/同步进程占用库时 VACUUM 失败：行已删除，下次独占时回收
}

const sizeMB = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2);
console.log(
	`prune 完成：删除 ${removed} 行（早于 ${cutoffHuman}）` +
		(vacuumed ? `，已 VACUUM，库 ${sizeMB}MB` : `；VACUUM 被占用跳过（行已删，文件待下次收缩）`),
);
