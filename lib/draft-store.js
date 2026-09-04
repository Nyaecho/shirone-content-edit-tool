/**
 * 【已退役】旧草稿暂存区 → 仓库迁移工具。
 *
 * 历史：草稿曾只存服务器磁盘（.drafts/），与仓库内容并存导致状态分裂。
 * 现状：草稿与发布同一存储——draft: true 写进 frontmatter 推 GitHub，仓库为唯一事实源。
 *
 * 本文件仅保留 migrateLegacyDrafts()：启动时（生产模式）把 .drafts/ 里遗留的
 * 暂存草稿（含图片）自动搬运推送到 GitHub，成功后清掉暂存文件。
 * 迁移是幂等的：路径已存在视为已迁移；目录为空则整体移除。
 * 全部迁移完成后本文件与 .drafts/ 目录可安全删除。
 */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { runtimeDirs } from "./config.js";
import * as store from "./store.js";

const draftsRoot = () => runtimeDirs.drafts;

function resolveDraft(relPath) {
  const root = path.resolve(draftsRoot());
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`非法路径：${relPath}`);
  return abs;
}

/** 读取草稿原文与 sidecar meta（不存在返回 null） */
async function getDraft(kind, id) {
  const relPath = `${kind}/${id}.md`;
  try {
    const raw = await fs.readFile(resolveDraft(relPath), "utf-8");
    let meta = null;
    try {
      meta = JSON.parse(await fs.readFile(resolveDraft(`${relPath}.meta.json`), "utf-8"));
    } catch {
      /* 无 meta */
    }
    return { raw, meta };
  } catch {
    return null;
  }
}

async function removeDraft(kind, id) {
  const relPath = `${kind}/${id}.md`;
  await fs.rm(resolveDraft(relPath), { force: true });
  await fs.rm(resolveDraft(`${relPath}.meta.json`), { force: true });
}

/** 读取暂存图片 */
async function getDraftImage(repoPath) {
  try {
    return { buffer: await fs.readFile(resolveDraft(`assets/${repoPath}`)) };
  } catch {
    return null;
  }
}

/** 暂存区是否存在任何待迁移内容 */
export function hasLegacyDrafts() {
  return fss.existsSync(draftsRoot());
}

/**
 * 迁移全部遗留暂存草稿到仓库。返回 { migrated, skipped, errors } 摘要。
 * 单个失败不阻断其他草稿（错误记录进摘要，下次启动重试）。
 */
export async function migrateLegacyDrafts() {
  const out = { migrated: 0, skipped: 0, errors: [] };
  if (!hasLegacyDrafts()) return out;

  const kinds = ["post", "moment"];
  for (const kind of kinds) {
    let entries = [];
    try {
      entries = await fs.readdir(resolveDraft(kind), { withFileTypes: true });
    } catch {
      continue; // 该类别无暂存
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const id = e.name.replace(/\.md$/, "");
      try {
        const draft = await getDraft(kind, id);
        if (!draft) continue;

        // 目标路径：与发布内容同构
        const targetPath = kind === "post" ? `content/posts/${id}/index.md` : `content/moments/${id}.md`;

        const existing = await store.getFile(targetPath);
        if (existing) {
          // 仓库已有同路径内容（如曾手动发布过）：跳过并清暂存
          await removeDraft(kind, id);
          out.skipped += 1;
          continue;
        }

        // 先推关联图片（meta.images 记录的暂存图片）
        for (const img of draft.meta?.images || []) {
          const data = await getDraftImage(img.repoPath);
          if (data) {
            await store.putFile(img.repoPath, data.buffer, `chore(asset): 迁移草稿图片 ${img.repoPath.split("/").pop()}`);
          }
        }
        // 再推 md，最后清暂存
        await store.putFile(targetPath, draft.raw, `feat(${kind}): 迁移暂存草稿 ${id}`);
        await removeDraft(kind, id);
        out.migrated += 1;
      } catch (err) {
        out.errors.push(`${kind}/${id}: ${err.message || err}`);
      }
    }
  }

  // 全部处理完且无错误：尝试删除残留目录（含已迁移完的图片缓存）
  if (out.errors.length === 0) {
    await fs.rm(draftsRoot(), { recursive: true, force: true }).catch(() => {});
  }
  return out;
}
