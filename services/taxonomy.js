/**
 * 分类法（taxonomy）聚合服务：汇总仓库内全部标签与文章分类，供编辑器快速复用。
 * 复用 posts / moments 的列表逻辑（生产模式读本地镜像，DEV 模式读本地 fs），单次全量聚合。
 */
import { listPosts } from "./posts.js";
import { listMoments } from "./moments.js";

/**
 * 聚合标签与分类，带使用计数：
 * - tags: [{ name, posts, moments, total }]，按总使用数降序
 * - categories: [{ name, count }]，按使用数降序
 */
export async function listTaxonomies() {
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
