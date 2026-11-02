/**
 * 简易并发池：固定数量 worker 按序领取任务，结果顺序与输入一致。
 * 由 services/posts.js 与 services/moments.js 的逐字重复实现收敛而来（行为零变化）。
 */
export async function pooled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
