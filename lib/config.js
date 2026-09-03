import fs from "node:fs";

/** 环境配置（进程启动时读取一次） */
const env = process.env;

export const config = {
  port: Number(env.PORT || 3777),
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

  dev: {
    enabled: env.DEV_MODE === "1" || env.DEV_MODE === "true",
    contentDir: env.DEV_CONTENT_DIR || "",
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
  return errors;
}

export const isDev = () => config.dev.enabled;
