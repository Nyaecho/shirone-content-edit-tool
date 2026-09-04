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
app.use(express.json({ limit: "2mb" }));

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
  startSync().then((s) => {
    if (s.status === "ok") console.log(`[sync] 镜像预热完成：${s.files} 文件 @ ${s.sha?.slice(0, 7) || "?"}`);
    else console.warn(`[sync] 镜像预热失败：${s.error}（读操作回退 GitHub API，可稍后手动同步）`);
  });
}

app.listen(config.port, () => {
  console.log(`shirone-admin 已启动: http://localhost:${config.port}`);
  console.log(`模式: ${isDev() ? "DEV（本地验证：保存触发下载）" : "PROD（推送 GitHub）"}`);
  if (isDev()) console.log(`内容仓: ${config.dev.contentDir}`);
  else console.log(`内容仓: ${config.github.owner}/${config.github.repo}@${config.github.branch}`);
  console.log(`站点时区: ${config.siteTimezone}`);
});
