/**
 * 路由层：认证、文章、动态、上传。
 * 统一响应包装：{ ok: true, data } / { ok: false, error }。
 */
import express from "express";
import {
  verifyPassword,
  recordFailure,
  recordSuccess,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  loginRateLimit,
} from "../lib/auth.js";
import { config, isDev } from "../lib/config.js";
import * as postsService from "../services/posts.js";
import * as momentsService from "../services/moments.js";
import { momentAssetPath, postAssetPath } from "../lib/content.js";
import { getImage } from "../lib/image-staging.js";
import JSZip from "jszip";
import crypto from "node:crypto";

export const router = express.Router();

// ---------- 认证 ----------

router.post("/login", loginRateLimit, (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(password)) {
    const ip = req.ip || "unknown";
    recordFailure(ip);
    return res.status(401).json({ ok: false, error: "密码错误" });
  }
  recordSuccess(req.ip || "unknown");
  setSessionCookie(req, res);
  res.json({ ok: true, data: { devMode: isDev() } });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/session", (req, res) => {
  res.json({ ok: true, data: { authenticated: false, devMode: isDev() } });
});

// 以下全部需要认证
router.use(requireAuth);

router.get("/me", (req, res) => {
  res.json({ ok: true, data: { devMode: isDev(), timezone: config.siteTimezone } });
});

// ---------- 文章 ----------

router.get("/posts", async (req, res) => {
  try {
    res.json({ ok: true, data: await postsService.listPosts() });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/posts/:slug", async (req, res) => {
  try {
    const post = await postsService.getPost(req.params.slug);
    if (!post) return res.status(404).json({ ok: false, error: "文章不存在" });
    res.json({ ok: true, data: post });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/posts", async (req, res) => {
  try {
    const { form, body } = req.body || {};
    const errors = postsService.validatePostInput(form || {}, { isNew: true });
    if (errors.length) return res.status(400).json({ ok: false, error: errors.join("；") });

    const result = await postsService.createPost(form || {}, String(body || ""), config.siteTimezone);
    await respondWithSave(res, result, {
      kind: "post",
      slug: result.slug,
      message: "文章创建成功",
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/posts/:slug", async (req, res) => {
  try {
    const { form, body } = req.body || {};
    const result = await postsService.updatePost(req.params.slug, form || {}, String(body || ""), config.siteTimezone);
    await respondWithSave(res, result, {
      kind: "post",
      slug: result.slug,
      message: result.moved ? "文章已保存（路径已移动）" : "文章保存成功",
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/posts/:slug", async (req, res) => {
  try {
    const result = await postsService.deletePost(req.params.slug);
    if (result.devDeleted) {
      return res.json({ ok: true, data: { message: `DEV 模式：已模拟删除 ${result.path}（无副作用）` } });
    }
    res.json({ ok: true, data: { message: "文章已删除", commitUrl: result.commitUrl } });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 动态 ----------

/**
 * 地点定位。
 * GET /api/geocode?lat=&lon=  → GPS 坐标逆地理（精确到省）
 * GET /api/geocode            → IP 定位兜底（无需浏览器授权）
 */
router.get("/geocode", async (req, res) => {
  try {
    const lat = req.query.lat != null ? Number(req.query.lat) : null;
    const lon = req.query.lon != null ? Number(req.query.lon) : null;
    if ((lat != null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) ||
        (lon != null && (!Number.isFinite(lon) || Math.abs(lon) > 180))) {
      return res.status(400).json({ ok: false, error: "坐标无效" });
    }
    const ip = req.headers["x-real-ip"] || req.ip || req.socket?.remoteAddress || "";
    const { locate } = await import("../lib/geocode.js");
    const result = await locate({ lat, lon, ip: String(ip) });
    if (!result) {
      return res.status(502).json({ ok: false, error: "定位解析失败，请手动填写地点" });
    }
    res.json({ ok: true, data: result });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/moments", async (req, res) => {
  try {
    res.json({ ok: true, data: await momentsService.listMoments() });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/moments/:id", async (req, res) => {
  try {
    const moment = await momentsService.getMoment(req.params.id);
    if (!moment) return res.status(404).json({ ok: false, error: "动态不存在" });
    res.json({ ok: true, data: moment });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/moments", async (req, res) => {
  try {
    const { form, body } = req.body || {};
    if (!String(body || "").trim() && !(Array.isArray(form?.images) && form.images.length)) {
      return res.status(400).json({ ok: false, error: "动态内容与图片不能同时为空" });
    }
    const result = await momentsService.createMoment(form || {}, String(body || ""), config.siteTimezone);
    await respondWithSave(res, result, { kind: "moment", id: result.id, message: "动态发布成功" });
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/moments/:id", async (req, res) => {
  try {
    const { form, body } = req.body || {};
    const result = await momentsService.updateMoment(req.params.id, form || {}, String(body || ""));
    await respondWithSave(res, result, { kind: "moment", id: result.id, message: "动态保存成功" });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/moments/:id", async (req, res) => {
  try {
    const result = await momentsService.deleteMoment(req.params.id);
    if (result.devDeleted) {
      return res.json({ ok: true, data: { message: `DEV 模式：已模拟删除 ${result.path}（无副作用）` } });
    }
    res.json({ ok: true, data: { message: "动态已删除", commitUrl: result.commitUrl } });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- 图片上传 ----------

/**
 * 上传图片。字段：
 * - target: "post" | "moment"
 * - slug: 文章 slug（target=post 时必填）
 * - momentDate: 动态日期 YYYY-MM-DD（target=moment 时必填，回填时用已有 published 的前 10 位）
 */
router.post("/upload", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message || "上传失败" });
    }
    try {
      const { target, slug, momentDate } = req.body || {};
      if (!req.file) return res.status(400).json({ ok: false, error: "缺少文件" });
      if (!["post", "moment"].includes(target)) {
        return res.status(400).json({ ok: false, error: "target 必须为 post 或 moment" });
      }

      const filename = uniqueName(req.file.originalname, req.file.buffer);
      let repoPath;
      if (target === "post") {
        if (!slug) return res.status(400).json({ ok: false, error: "缺少文章 slug" });
        repoPath = postAssetPath(slug, filename);
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(momentDate || "")) {
          return res.status(400).json({ ok: false, error: "momentDate 格式应为 YYYY-MM-DD" });
        }
        repoPath = momentAssetPath(momentDate, filename);
      }

      // 生产模式直接推送到仓库；DEV 模式暂存内存
      if (!isDev()) {
        const { putFile } = await import("../lib/github.js");
        await putFile(repoPath, req.file.buffer, `chore(asset): 上传图片 ${filename}`);
      } else {
        const { putImage } = await import("../lib/image-staging.js");
        putImage(repoPath, req.file.buffer, req.file.mimetype);
      }

      const webPath = repoPath.startsWith("public/") ? `/${repoPath.slice("public/".length)}` : `/${repoPath}`;
      // 文章目录内图片使用相对引用（./filename），其余用根路径
      const markdownRef =
        target === "post" ? `![${filename}](./${filename})` : `![${filename}](${webPath})`;

      res.json({ ok: true, data: { repoPath, webPath, markdownRef, filename } });
    } catch (uploadErr) {
      handleError(res, uploadErr);
    }
  });
});

// ---------- 保存响应（DEV 下载 / 生产提交链接） ----------

async function respondWithSave(res, result, { kind, slug, id, message }) {
  if (result.devDownload) {
    // DEV：把文件 + 本会话引用的暂存图片打包下载
    const referenced = await collectReferencedImages(result.raw);
    await sendDownload(res, result.path, result.raw, referenced);
    return;
  }
  res.json({
    ok: true,
    data: {
      message,
      path: result.path,
      kind,
      slug,
      id,
      commitUrl: result.commitUrl,
      actionsUrl: actionsUrl(),
      moved: result.moved || false,
      oldRemoved: result.oldRemoved || false,
    },
  });
}

/** 从 Markdown 原文中收集本会话暂存的图片（DEV 下载用） */
async function collectReferencedImages(raw) {
  const { extractImagePaths } = await import("../lib/content.js");
  const paths = extractImagePaths(raw);
  const out = [];
  for (const p of paths) {
    // 相对引用 ./xxx → 与 md 同目录；这里由调用方替换绝对 repoPath
    out.push(p);
  }
  return out;
}

/** 生成下载响应：无图 → .md；有图 → .zip */
async function sendDownload(res, mdPath, raw, referencedRelPaths) {
  const mdDir = mdPath.includes("/") ? mdPath.replace(/\/[^/]+$/, "") : "";
  // 把相对引用转成仓库绝对路径
  const repoPathOf = (ref) => {
    if (ref.startsWith("./")) return `${mdDir}/${ref.slice(2)}`;
    if (ref.startsWith("/")) return `public${ref}`;
    return ref;
  };

  const files = [];
  for (const ref of referencedRelPaths) {
    const img = getImage(repoPathOf(ref));
    if (img) files.push({ path: repoPathOf(ref), buffer: img.buffer });
  }

  if (files.length === 0) {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(mdPath.split("/").pop())}`,
    );
    res.setHeader("X-Suggested-Filename", mdPath.split("/").pop());
    return res.send(raw);
  }

  const zip = new JSZip();
  zip.file(mdPath, raw);
  for (const f of files) zip.file(f.path, f.buffer);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  const zipName = `${mdPath.split("/").slice(-2, -1)[0] || "shirone"}-bundle.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
  );
  res.setHeader("X-Suggested-Filename", zipName);
  return res.send(buffer);
}

function actionsUrl() {
  if (!config.github.owner || !config.github.repo) return null;
  return `https://github.com/${config.github.owner}/${config.github.repo}/actions`;
}

function uniqueName(originalName, buffer) {
  const ext = (originalName.match(/\.[a-z0-9]+$/i) || [".png"])[0].toLowerCase();
  const hash = crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 8);
  const stamp = new Date().toISOString().slice(5, 10).replace("-", "");
  return `${stamp}-${hash}${ext}`;
}

function handleError(res, err) {
  const status = err.code === "CONFLICT" ? 409 : err.code === "NOT_FOUND" ? 404 : err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, error: err.message || "服务器内部错误" });
}

// multer 顶部初始化（内存存储，单文件 20MB）
import multer from "multer";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error("仅支持图片文件"));
  },
});
