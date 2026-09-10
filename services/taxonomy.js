/**
 * 分类法（taxonomy）聚合服务：汇总仓库内全部标签与文章分类，供编辑器快速复用。
 * 复用 posts / moments 的列表逻辑（生产模式读本地镜像，DEV 模式读本地 fs），单次全量聚合。
 *
 * 生产模式带磁盘缓存（<MIRROR_DIR>/taxonomies.json）：聚合结果持久化，
 * 重启/刷新后立即可用（不依赖重新点同步）；仅在镜像同步成功或内容写入后失效，
 * 下次请求懒重建。DEV 模式直读本地文件仓、不走缓存（外部编辑即时可见）。
 */
import fss from "node:fs";
import path from "node:path";
import { config, isDev } from "../lib/config.js";
import { listPosts } from "./posts.js";
import { listMoments } from "./moments.js";

const cacheFile = () => path.join(config.mirror.dir, "taxonomies.json");

/** 读取磁盘缓存（不存在/损坏返回 null） */
function readCache() {
  try {
    const parsed = JSON.parse(fss.readFileSync(cacheFile(), "utf-8"));
    return parsed?.data || null;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    fss.mkdirSync(config.mirror.dir, { recursive: true });
    fss.writeFileSync(
      cacheFile(),
      JSON.stringify({ computedAt: new Date().toISOString(), data }, null, 2),
      "utf-8",
    );
  } catch {
    /* 缓存写入失败不影响请求，下次再试 */
  }
}

/** 使缓存失效（镜像同步成功 / 内容写入删除后调用；下次请求懒重建） */
export function invalidateCache() {
  try {
    fss.rmSync(cacheFile(), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 聚合标签与分类，带使用计数：
 * - tags: [{ name, posts, moments, total }]，按总使用数降序
 * - categories: [{ name, count }]，按使用数降序
 */
export async function listTaxonomies({ refresh = false } = {}) {
  if (!isDev() && !refresh) {
    const cached = readCache();
    if (cached) return cached;
  }
  const data = await aggregate();
  if (!isDev()) writeCache(data);
  return data;
}

async function aggregate() {
  const [posts, moments] = await Promise.all([listPosts(), listMoments()]);

  const tagMap = new Map(); // name -> { name, posts, moments }
  const catMap = new Map(); // name -> count

  for (const p of posts) {
    for (const raw of p.tags || []) {
      const name = String(raw).trim();
      if (!name) continue;
      if (!tagMap.has(name)) tagMap.set(name, { name, posts: 0, moments: 0 });
      tagMap.get(name).posts += 1;
    }
    const category = String(p.category || "").trim();
    if (category) {
      catMap.set(category, (catMap.get(category) || 0) + 1);
    }
  }

  for (const m of moments) {
    for (const raw of m.tags || []) {
      const name = String(raw).trim();
      if (!name) continue;
      if (!tagMap.has(name)) tagMap.set(name, { name, posts: 0, moments: 0 });
      tagMap.get(name).moments += 1;
    }
  }

  const tags = [...tagMap.values()]
    .map((t) => ({ ...t, total: t.posts + t.moments }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "zh-Hans-CN"));
  const categories = [...catMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"));

  return { tags, categories };
}
