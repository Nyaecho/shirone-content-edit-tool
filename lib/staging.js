/**
 * 服务器暂存层（autosave staging）：自动保存/Ctrl+S 的落地存储。
 *
 * 设计要点（与仓库存储的边界）：
 * - 自动保存只写这里，**不推 GitHub**；点「暂存」（draft:true 推送）或「发布」
 *   才走 store.putFile，推送成功后由 absorbDraft() 吸收清除暂存
 * - 图片上传一律先进暂存区（不推仓库），推送时按正文引用收集搬运
 * - 单人使用场景：暂存保留直到被吸收或手动丢弃，不设 TTL
 *
 * 目录结构（root 由 env STAGING_DIR 配置，默认 ./.staging）：
 *   <root>/drafts/<kind>/<id>.json      内容快照 {form, body, images[], savedAt, baseSha}
 *   <root>/assets/<repoPath>            暂存图片（repoPath 含 content/ 或 public/ 前缀）
 *   <root>/assets/.refs.json            图片引用计数（key=repoPath, value=引用的草稿 id 列表）
 *
 * kind: "post" | "moment" | "timeline"
 * id  : post → slug（新建无 slug 用 "_new-<ts>" 临时键）；moment → 已有 id 或 "_new-<ts>"；
 *       timeline → 固定 "main"
 */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { isDev } from "./config.js";

const root = () => process.env.STAGING_DIR || "./.staging";

function resolveIn(base, relPath) {
  const absRoot = path.resolve(base);
  const abs = path.resolve(absRoot, relPath);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) throw new Error(`非法路径：${relPath}`);
  return abs;
}

const draftFile = (kind, id) => `drafts/${kind}/${id}.json`;
const assetFile = (repoPath) => `assets/${repoPath}`;

// ---------- 草稿快照 ----------

/** 校验 kind/id 合法性（防路径穿越：id 不允许斜杠与 ..） */
function validKey(kind, id) {
  if (!["post", "moment", "timeline"].includes(kind)) throw new Error(`未知类型：${kind}`);
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(String(id))) throw new Error(`非法 id：${id}`);
}

/** 写入草稿快照（自动保存/Ctrl+S 调用）。payload: {form, body, images[], baseSha} */
export async function saveDraft(kind, id, payload) {
  validKey(kind, id);
  const abs = resolveIn(root(), draftFile(kind, id));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const snapshot = {
    kind,
    id: String(id),
    form: payload.form ?? {},
    body: String(payload.body ?? ""),
    images: Array.isArray(payload.images) ? payload.images : [],
    baseSha: payload.baseSha ?? null,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(abs, JSON.stringify(snapshot, null, 2), "utf-8");
  // 引用计数同步：快照里登记的图片全部关联到本草稿
  await refAssets(kind, String(id), (snapshot.images || []).map((i) => i?.repoPath).filter(Boolean));
  return { savedAt: snapshot.savedAt };
}

/** 读取草稿快照；不存在返回 null */
export async function getDraft(kind, id) {
  validKey(kind, id);
  try {
    const raw = await fs.readFile(resolveIn(root(), draftFile(kind, id)), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 列出某类型全部草稿摘要（列表页角标合并用） */
export async function listDrafts(kind) {
  const dir = resolveIn(root(), `drafts/${kind}`);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    try {
      const snap = JSON.parse(await fs.readFile(path.join(dir, e.name), "utf-8"));
      out.push({
        id: snap.id,
        savedAt: snap.savedAt,
        // 摘要字段：列表角标只需「有没有、新不新」
        title: snap.form?.title || snap.form?.excerpt || snap.id,
        draftFlag: snap.form?.draft === true,
        bodyLength: (snap.body || "").length,
      });
    } catch {
      /* 损坏快照跳过 */
    }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/** 删除草稿快照（丢弃/吸收后调用）；图片引用计数同步扣减 */
export async function deleteDraft(kind, id) {
  validKey(kind, id);
  const snap = await getDraft(kind, id);
  const abs = resolveIn(root(), draftFile(kind, id));
  await fs.rm(abs, { force: true });
  if (snap && Array.isArray(snap.images)) {
    for (const img of snap.images) {
      if (img?.repoPath) await unrefAsset(img.repoPath, `${kind}/${id}`);
    }
  }
  return true;
}

// ---------- 暂存图片 ----------

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|svg|bmp|ico)$/i;

/** 暂存一张图片（不推仓库）。repoPath 必须以 content/ 或 public/ 开头（与最终推送路径一致） */
export async function putStagedImage(repoPath, buffer) {
  if (!repoPath.startsWith("content/") && !repoPath.startsWith("public/")) {
    throw new Error(`暂存图片路径必须在 content/ 或 public/ 下：${repoPath}`);
  }
  if (!IMAGE_EXT_RE.test(repoPath)) throw new Error(`不支持的图片格式：${repoPath}`);
  const abs = resolveIn(root(), assetFile(repoPath));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  return { repoPath };
}

/** 读取暂存图片；不存在返回 null */
export async function getStagedImage(repoPath) {
  try {
    return await fs.readFile(resolveIn(root(), assetFile(repoPath)));
  } catch {
    return null;
  }
}

/** 暂存图片是否存在 */
export function hasStagedImage(repoPath) {
  return fss.existsSync(resolveIn(root(), assetFile(repoPath)));
}

/** 暂存图片的磁盘绝对路径（删除旧封面等运维清理用） */
export function stagingAssetPath(repoPath) {
  return resolveIn(root(), assetFile(repoPath));
}

// ---------- 引用计数（吸收/丢弃草稿后清理无主图片） ----------

async function readRefs() {
  try {
    return JSON.parse(await fs.readFile(resolveIn(root(), "assets/.refs.json"), "utf-8"));
  } catch {
    return {};
  }
}

async function writeRefs(refs) {
  const abs = resolveIn(root(), "assets/.refs.json");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(refs, null, 2), "utf-8");
}

/** 草稿快照保存时登记引用 */
async function refAssets(kind, id, repoPaths) {
  const refs = await readRefs();
  const key = `${kind}/${id}`;
  for (const p of repoPaths) {
    if (!Array.isArray(refs[p])) refs[p] = [];
    if (!refs[p].includes(key)) refs[p].push(key);
  }
  // 该草稿不再引用的路径要移除
  for (const p of Object.keys(refs)) {
    if (repoPaths.includes(p)) continue;
    refs[p] = refs[p].filter((k) => k !== key);
    if (refs[p].length === 0) delete refs[p];
  }
  await writeRefs(refs);
}

async function unrefAsset(repoPath, key) {
  const refs = await readRefs();
  if (!Array.isArray(refs[repoPath])) return;
  refs[repoPath] = refs[repoPath].filter((k) => k !== key);
  if (refs[repoPath].length === 0) {
    delete refs[repoPath];
    // 无主图片直接删除（暂存区只是中转，不是相册）
    await fs.rm(resolveIn(root(), assetFile(repoPath)), { force: true }).catch(() => {});
  }
  await writeRefs(refs);
}

// ---------- 吸收（推送成功后调用） ----------

/**
 * 推送成功后的吸收：把暂存图片中「正文引用到的」搬运推送仓库，
 * 清除草稿快照与无主暂存图片。
 * @param kind, id  草稿键
 * @param raw       已推送的 Markdown 全文（用于解析引用）
 * @param extraPaths 额外必推路径（动态九宫格 frontmatter images 的仓库路径）
 * @param putFile   (path, buffer, message) => Promise，由调用方注入 store.putFile
 */
export async function absorbDraft(kind, id, raw, extraPaths = [], putFile) {
  validKey(kind, id);
  const snap = await getDraft(kind, id);
  if (!snap) return { absorbed: false, pushed: [] };

  const { extractImagePaths } = await import("./content.js");
  const bodyRefs = extractImagePaths(String(raw || ""));
  // 相对引用 ./xxx → 仓库绝对路径（md 所在目录由路由层知识补全，这里用快照里登记的 images 匹配）
  const wanted = new Set(extraPaths);
  for (const img of snap.images || []) {
    const rp = img?.repoPath;
    if (!rp) continue;
    const name = rp.split("/").pop();
    const referenced = bodyRefs.some((ref) => ref === rp || ref.endsWith(`/${name}`) || ref === `./${name}`);
    if (referenced || extraPaths.includes(rp)) wanted.add(rp);
  }

  const pushed = [];
  if (putFile) {
    for (const rp of wanted) {
      if (!hasStagedImage(rp)) continue; // 仓库已有图（编辑老文章场景），无需重推
      const buf = await getStagedImage(rp);
      if (buf) {
        await putFile(rp, buf, `chore(asset): 暂存图片随草稿搬运 ${rp.split("/").pop()}`);
        pushed.push(rp);
      }
    }
  }
  await deleteDraft(kind, id);
  return { absorbed: true, pushed };
}

// ---------- 引用登记（saveDraft 内部调用；导出供特殊场景手动登记） ----------

export { refAssets };
