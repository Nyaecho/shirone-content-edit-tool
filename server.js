/**
 * shirone-admin 入口：Express 服务 + 静态托管 + API 挂载。
 * 启动：node --env-file=.env server.js
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, validateConfig, isDev } from "./lib/config.js";
import { router } from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true); // 反代下取真实 IP 与 x-forwarded-proto
// 全局 JSON 解析；verify 回调顺带捕获原始字节（部署 webhook 验签需要，
// body-parser 的 req._body 机制会让路由级二次解析静默跳过，必须在这里拿）
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

app.use("/api", router);

// 静态资源
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { index: "index.html", extensions: ["html"] }));

// SPA 兜底
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// 启动前校验配置
const errors = validateConfig();
if (errors.length) {
  console.error("配置校验失败：");
  for (const e of errors) console.error(`  - ${e}`);
  console.error("请参考 .env.example 配置后重启。");
  process.exit(1);
}

// 生产模式：启动时异步预热镜像（不阻塞监听；失败不影响服务，读操作回退 GitHub API）
if (!isDev()) {
  const { startSync } = await import("./lib/sync.js");
  startSync().then(async (s) => {
    if (s.status === "ok") console.log(`[sync] 镜像预热完成：${s.files} 文件 @ ${s.sha?.slice(0, 7) || "?"}`);
    else console.warn(`[sync] 镜像预热失败：${s.error}（读操作回退 GitHub API，可稍后手动同步）`);

    // 旧暂存草稿迁移（一次性；.drafts/ 不存在时为空操作）
    const { migrateLegacyDrafts, hasLegacyDrafts } = await import("./lib/draft-store.js");
    if (hasLegacyDrafts()) {
      const r = await migrateLegacyDrafts();
      console.log(`[drafts] 旧暂存草稿迁移：${r.migrated} 已推送，${r.skipped} 跳过，${r.errors.length} 失败`);
      for (const e of r.errors) console.warn(`[drafts] 迁移失败：${e}`);
    }
  });
}

app.listen(config.port, () => {
  console.log(`shirone-admin 已启动: http://localhost:${config.port}`);
  console.log(`模式: ${isDev() ? "DEV（本地验证：保存触发下载）" : "PROD（推送 GitHub）"}`);
  if (isDev()) console.log(`内容仓: ${config.dev.contentDir}`);
  else console.log(`内容仓: ${config.github.owner}/${config.github.repo}@${config.github.branch}`);
  console.log(`站点时区: ${config.siteTimezone}`);
});
