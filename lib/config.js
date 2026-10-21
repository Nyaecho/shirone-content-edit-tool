import fs from "node:fs";

/** 环境配置（进程启动时读取一次） */
const env = process.env;

export const config = {
  port: Number(env.PORT || 3777),
  /** 监听地址：默认仅本地回环（公网经 nginx 反代访问，不暴露服务端口） */
  host: env.HOST || "127.0.0.1",
  adminPassword: env.ADMIN_PASSWORD || "",
  sessionSecret: env.SESSION_SECRET || env.ADMIN_PASSWORD || "shirone-admin-secret",

  github: {
    token: env.GITHUB_TOKEN || "",
    owner: env.GITHUB_OWNER || "",
    repo: env.GITHUB_REPO || "",
    branch: env.GITHUB_BRANCH || "main",
  },

  siteTimezone: env.SITE_TIMEZONE || "Asia/Shanghai",

  geocode: {
    provider: env.GEOCODE_PROVIDER || "nominatim",
    amapKey: env.AMAP_KEY || "",
  },

  commitAuthor: {
    name: env.COMMIT_AUTHOR_NAME || "shirone-admin",
    email: env.COMMIT_AUTHOR_EMAIL || "admin@example.com",
  },

  deploy: {
    // webhook HMAC 密钥（与主题仓 DEPLOY_HOOK_SECRET 一致）；未配置则部署路由返回 503
    secret: env.DEPLOY_SECRET || "",
    // 服务器上 blog 仓库路径（稀疏检出 dist 的克隆）
    dir: env.DEPLOY_DIR || "/www/wwwroot/blog",
    // 构建产物分支（Actions 把 dist 以 orphan commit 推到该分支）
    branch: env.DEPLOY_BRANCH || "deploy",
  },

  dev: {
    enabled: env.DEV_MODE === "1" || env.DEV_MODE === "true",
    contentDir: env.DEV_CONTENT_DIR || "",
  },

  mirror: {
    // 仓库内容磁盘镜像目录（生产模式读操作优先走镜像）
    dir: env.MIRROR_DIR || "./.mirror",
  },

  mihealth: {
    // mihealth-api 同步产出的 SQLite 库路径（只读打开；未配置则健康路由 503）
    db: env.MIHEALTH_DB || "",
    // 快照默认统计天数（1~30，路由 ?days= 可覆盖）
    days: Number(env.MIHEALTH_DAYS || 7),
    // 自动同步间隔（毫秒，默认 1 小时；进程内定时器，替代 cron）
    syncIntervalMs: Number(env.MIHEALTH_SYNC_INTERVAL_MS || 60 * 60 * 1000),
    // 快照内存缓存 TTL（毫秒）
    cacheTtlMs: Number(env.MIHEALTH_CACHE_TTL_MS || 10 * 60 * 1000),
  },
};

/** 草稿暂存目录（启动后可用，路径默认相对 cwd） */
export const runtimeDirs = {
  get drafts() {
    return process.env.DRAFTS_DIR || "./.drafts";
  },
};

/** 校验配置完整性，返回缺失项描述数组（空数组 = 通过） */
export function validateConfig() {
  const errors = [];
  if (!config.adminPassword) {
    errors.push("ADMIN_PASSWORD 未设置");
  }
  if (config.dev.enabled) {
    if (!config.dev.contentDir) {
      errors.push("DEV_MODE=1 时必须设置 DEV_CONTENT_DIR");
    } else if (!fs.existsSync(config.dev.contentDir)) {
      errors.push(`DEV_CONTENT_DIR 路径不存在: ${config.dev.contentDir}`);
    }
  } else {
    if (!config.github.token) errors.push("GITHUB_TOKEN 未设置");
    if (!config.github.owner) errors.push("GITHUB_OWNER 未设置");
    if (!config.github.repo) errors.push("GITHUB_REPO 未设置");
  }
  // 部署功能可选：配了 DEPLOY_SECRET 即启用
  return errors;
}

export const isDev = () => config.dev.enabled;
