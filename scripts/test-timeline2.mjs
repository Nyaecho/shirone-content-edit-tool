/**
 * 临时验证脚本：services/timeline.js 全链路离线自测（走真实代码路径）。
 * 原理：DEV_MODE=1 时 lib/store.js 读操作走 dev-store（本地内容仓 fs），
 * 写操作返回 devDownload 产物（不落盘），恰好完整驱动解析→变更→序列化。
 *
 * 用法：在 shirone-admin 目录下：
 *   DEV_MODE=1 DEV_CONTENT_DIR=../Shirone-Content node scripts/test-timeline.mjs
 */
import { parseTimelineFile, listTimeline, mutateTimeline } from "../services/timeline.js";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ---------- 1. 解析 ----------
console.log("\n[1] parseTimelineFile");
const parsed = await parseTimelineFile();
assert(Array.isArray(parsed.items), `解析出数组（${parsed.items.length} 项）`);
assert(parsed.items[0]?.title === "个人博客初步搭建完成", "首项 title 正确");
assert(parsed.items[0]?.featured === true, "featured 布尔值正确");
assert(Array.isArray(parsed.items[0]?.highlights) && parsed.items[0].highlights.length === 3, "highlights 数组正确");
assert(parsed.items[0]?.links?.[0]?.icon === "fa6-brands:github", "links 嵌套对象正确");
assert(parsed.prefix.includes("export const timelineData"), "prefix 含声明");
assert(parsed.suffix.trim().startsWith(";"), "suffix 含收尾分号");

// ---------- 2. 序列化往返：无变更 update 应产出语义等价内容 ----------
console.log("\n[2] 序列化往返（无变更 update）");
const snapshot = JSON.parse(JSON.stringify(parsed.items[0]));
const result = await mutateTimeline("update", { index: 0, original: snapshot, item: snapshot });
assert(result.devDownload === true, "DEV 模式返回下载产物");
const raw = result.contentRaw;
assert(raw.includes("个人博客初步搭建完成"), "写回内容含中文标题（不转义）");
assert(/\t\ttitle: "个人博客初步搭建完成",/.test(raw), "tab 缩进 + 双引号 + 尾逗号");
assert(raw.includes("featured: true,"), "featured: true 写回");
assert(!raw.includes("enable: false"), "enable 未写（非 false）");
const declOk = /export\s+const\s+timelineData\b[^=]*=\s*(\[)/.exec(raw);
assert(declOk != null, "写回产物仍是合法声明");

// ---------- 3. 新增节点 ----------
console.log("\n[3] create");
const created = await mutateTimeline("create", {
  item: {
    title: "测试节点",
    date: "2026.09.15",
    category: "project",
    subtitle: "验证用",
    description: "临时节点",
    highlights: ["要点一", "要点二"],
    tags: ["测试"],
    links: [{ label: "示例", url: "https://example.com", icon: "mdi:link" }],
    featured: false,
    enable: true,
  },
});
assert(created.contentRaw.includes("测试节点"), "新节点已写入");
const testNodeSeg = created.contentRaw.slice(created.contentRaw.indexOf("测试节点"));
assert(!testNodeSeg.includes("featured:"), "featured: false 省略");
assert(!testNodeSeg.includes("enable:"), "enable: true 省略");
assert(created.contentRaw.includes("要点一"), "highlights 写入");

// ---------- 4. 校验逻辑 ----------
console.log("\n[4] 校验");
try {
  await mutateTimeline("create", { item: { title: "", date: "2026.01" } });
  assert(false, "空 title 应被拒绝");
} catch (e) {
  assert(e.status === 400 && e.message.includes("标题"), `空 title 报 400（${e.message}）`);
}
try {
  await mutateTimeline("create", { item: { title: "x", date: "2026.01", category: "不存在" } });
  assert(false, "非法 category 应被拒绝");
} catch (e) {
  assert(e.status === 400 && e.message.includes("分类"), `非法 category 报 400（${e.message}）`);
}
try {
  await mutateTimeline("create", { item: { title: "x", date: "2026.01", links: [{ label: "a", url: "ftp://b.c" }] } });
  assert(false, "非 http 链接应被拒绝");
} catch (e) {
  assert(e.status === 400 && e.message.includes("URL"), `非 http(s) URL 报 400（${e.message}）`);
}

// ---------- 5. 冲突检测 ----------
console.log("\n[5] 冲突检测");
try {
  const stale = { ...snapshot, title: "已被外部修改的旧快照" };
  await mutateTimeline("update", { index: 0, original: stale, item: snapshot });
  assert(false, "过期快照应报冲突");
} catch (e) {
  assert(e.code === "CONFLICT", `过期快照报 409（${e.message}）`);
}

// ---------- 6. 删除 ----------
console.log("\n[6] delete");
const del = await mutateTimeline("delete", { index: 0, original: snapshot });
assert(!del.contentRaw.includes("个人博客初步搭建完成"), "目标节点已删除");
// DEV 模式 putFile 不落盘：第 3 步的“测试节点”从未持久化，此处删的是原始唯一节点 → 数组应为空
assert(/=\s*\[\];/.test(del.contentRaw), "空数组序列化为 = [];");

// ---------- 7. 分类清单 ----------
console.log("\n[7] categories");
const list = await listTimeline();
assert(Array.isArray(list.categories) && list.categories.length === 4, `yaml 分类解析（${list.categories?.length} 个）`);
assert(list.categories?.some((c) => c.key === "milestone"), "含 milestone 分类");

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
