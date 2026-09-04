/**
 * 仓库同步：一次性拉取分支 tarball（codeload），流式解压进本地镜像。
 * - 单请求替代 N 次 Contents API，读操作全部落在本地磁盘
 * - 手动触发（前端同步按钮）+ 启动时预热（异步，不阻塞启动）
 * - 单飞行任务：并发调用共享同一进行中的同步
 * - 进度经 onProgress 回调上报（用于 /api/sync/status 轮询）
 */
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createWriteStream, createReadStream, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import * as mirror from "./mirror-store.js";

const STATE = {
  status: "idle", // idle | running | ok | error
  phase: null, // running 时的阶段：connecting | downloading | extracting
  startedAt: null,
  finishedAt: null,
  error: null,
  bytes: 0,
  totalBytes: null, // tarball Content-Length（codeload 有时分块传输拿不到，则 null）
  estBytes: null, // 上次同步的 tarball 大小：无 Content-Length 时的进度估算基准
  files: 0,
  sha: null, // tarball 对应 commit
};

const inflight = { promise: null };

export function syncState() {
  return { ...STATE };
}

function setProgress(patch) {
  Object.assign(STATE, patch);
}

/**
 * 触发一次同步。已有同步进行中则直接返回其 promise。
 * @param {(s: object) => void} [onProgress] 进度回调（本地触发时用于实时推送）
 */
export function startSync(onProgress) {
  if (inflight.promise) return inflight.promise;
  inflight.promise = runSync(onProgress).finally(() => {
    inflight.promise = null;
  });
  return inflight.promise;
}

async function runSync(onProgress) {
  const report = (patch) => {
    setProgress(patch);
    if (onProgress) {
      try {
        onProgress(syncState());
      } catch {
        /* 回调异常不影响同步 */
      }
    }
  };

  // 上次 tarball 大小 → 本轮进度估算（codeload 分块传输拿不到 Content-Length 时也能显示百分比）
  const estBytes = mirror.lastMeta()?.bytes || null;
  report({
    status: "running",
    phase: "connecting",
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    bytes: 0,
    totalBytes: null,
    estBytes,
    files: 0,
    sha: null,
  });

  try {
    await fs.mkdir(config.mirror.dir, { recursive: true });
    await mirror.resetStaging();

    // 1. 解析分支头 commit（同时作为 tarball 的 sha 依据）
    const headRes = await fetch(
      `https://api.github.com/repos/${config.github.owner}/${config.github.repo}/git/ref/heads/${encodeURIComponent(config.github.branch)}`,
      { headers: ghHeaders() },
    );
    if (!headRes.ok) throw new Error(`获取分支信息失败（HTTP ${headRes.status}）`);
    const head = await headRes.json();
    const sha = head.object?.sha || null;

    // 2. 下载分支 tarball（codeload，单请求包含全仓库）
    const tarRes = await fetch(
      `https://codeload.github.com/${config.github.owner}/${config.github.repo}/tar.gz/refs/heads/${encodeURIComponent(config.github.branch)}`,
      { headers: ghHeaders() },
    );
    if (!tarRes.ok) throw new Error(`tarball 下载失败（HTTP ${tarRes.status}）`);
    if (!tarRes.body) throw new Error("tarball 响应无内容");

    const tarFile = path.join(config.mirror.dir, "repo.tar.gz");
    report({ sha, totalBytes: Number(tarRes.headers.get("content-length")) || null, phase: "downloading" });
    // 停滞看门狗：连续 STALL_MS 无新字节视为连接死亡（codeload 龟速常见），中止重试
    await pipeline(
      tarRes.body,
      countBytes(tarRes, (n) => report({ bytes: n })),
      stallWatch(() => { throw new Error("下载停滞（60 秒无数据），请检查服务器到 GitHub 的连通性"); }),
      createWriteStream(tarFile),
    );

    // 3. 解压进 staging，并把唯一顶层目录（codeload 为 <owner>-<repo>-<ref>）的内容上移一层
    report({ bytes: (await fs.stat(tarFile)).size, phase: "extracting" });
    const files = await extractTar(tarFile, mirror.stagingPath(), (n) => report({ files: n }));
    await fs.rm(tarFile, { force: true });
    await hoistSingleRoot(mirror.stagingPath());

    // 4. 原子替换 current，写 meta.json 完成标记
    await mirror.promoteStaging({
      sha,
      branch: config.github.branch,
      syncedAt: new Date().toISOString(),
      files,
      bytes: STATE.bytes, // 供下轮同步估算进度
    });
    report({ status: "ok", phase: null, finishedAt: Date.now(), files });
  } catch (err) {
    report({ status: "error", phase: null, error: err.message || "同步失败", finishedAt: Date.now() });
  }
  return syncState();
}

function ghHeaders(extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.github.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

/**
 * GitHub tarball 的所有条目都位于唯一顶层目录（<owner>-<repo>-<ref>）之下。
 * 把该目录的内容上移一层，使 staging 根即仓库根。异常结构（多顶层/空）保持原样。
 */
async function hoistSingleRoot(stagingDir) {
  let entries;
  try {
    entries = await fs.readdir(stagingDir);
  } catch {
    return;
  }
  const visible = entries.filter((n) => !n.startsWith("."));
  if (visible.length !== 1) return;
  const rootDir = path.join(stagingDir, visible[0]);
  const stat = await fs.stat(rootDir).catch(() => null);
  if (!stat?.isDirectory()) return;
  // 移动顶层目录内容到 staging 根（rename 原子且廉价）
  for (const name of await fs.readdir(rootDir)) {
    await fs.rename(path.join(rootDir, name), path.join(stagingDir, name));
  }
  await fs.rmdir(rootDir).catch(() => {});
}

/** 计数 Transform，边下载边上报字节数 */
function countBytes(_res, onCount) {
  let n = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      onCount(n);
      cb(null, chunk);
    },
  });
}

/** 停滞看门狗：数据流动时重置计时；超时未流动则销毁流（pipeline 随之 reject） */
function stallWatch(onStall, stallMs = 60_000) {
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // destroy 的 Error 会成为 pipeline 的拒绝原因
      watchdog.destroy(new Error(onStall instanceof Function ? onStall().message : "下载停滞"));
    }, stallMs);
  };
  const watchdog = new Transform({
    transform(chunk, _enc, cb) {
      arm();
      cb(null, chunk);
    },
    flush(cb) {
      clearTimeout(timer);
      cb();
    },
  });
  watchdog.on("close", () => clearTimeout(timer));
  arm();
  return watchdog;
}

/**
 * 解压 .tar.gz 到 destDir。仅用 Node 内置 zlib，逐 entry 解析（无需 tar 依赖）。
 * tar 条目头 512 字节：name(100) mode(8) uid(8) gid(8) size(12) mtime(12) chksum(8)
 * typeflag(1) linkname(100) magic(6) ... prefix(155)。size 为八进制。
 * 仅处理普通文件与目录，其余（链接等）跳过；返回解压出的文件数。
 */
export async function extractTar(tarFile, destDir, onFile) {
  const zlib = await import("node:zlib");
  const gunzip = zlib.createGunzip();

  return new Promise((resolve, reject) => {
    let count = 0;
    let remainder = Buffer.alloc(0); // 上一 chunk 未消费的字节
    let entry = null; // 当前条目 { name, size, type, remaining, absPath? }
    let entryStream = null;
    const openStreams = new Set(); // 等待刷盘的写入流，防止 rename 竞态
    let ended = false;

    const src = createReadStream(tarFile);
    src.on("error", reject);
    gunzip.on("error", reject);

    src.pipe(gunzip);

    function maybeFinish() {
      if (ended && openStreams.size === 0) resolve(count);
    }

    gunzip.on("data", (chunk) => {
      let buf = Buffer.concat([remainder, chunk]);
      remainder = Buffer.alloc(0);

      while (true) {
        if (entry) {
          // 消费当前条目的内容字节（含按 512 对齐的填充块——tar 规定内容后补齐到边界）
          const take = Math.min(entry.remaining, buf.length);
          if (take > 0) {
            if (entry.type === "file") entryStream.write(buf.subarray(0, take));
            buf = buf.subarray(take);
            entry.remaining -= take;
          }
          if (entry.remaining > 0) return; // 内容未完，等下一个 chunk
          // 补齐块：消费内容后到下一个 512 边界的填充（size 已换算为含 padding 的总长）
          while (entry.pad > 0 && buf.length > 0) {
            const skip = Math.min(entry.pad, buf.length);
            buf = buf.subarray(skip);
            entry.pad -= skip;
          }
          if (entry.pad > 0) return; // 填充未完
          finishEntry();
          if (buf.length === 0) return;
          continue;
        }
        if (buf.length < 512) {
          remainder = buf;
          return;
        }
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        entry = parseHeader(header, destDir);
        if (entry === null) continue; // 结束块
        if (entry.type === "file") {
          // 普通文件：建写入流并跟踪，等待 finish 后才算完成（捕获局部引用，避免闭包置 null 竞态）
          const ws = createWriteStream(entry.absPath, { mode: entry.mode });
          entryStream = ws;
          openStreams.add(ws);
          ws.on("finish", () => {
            openStreams.delete(ws);
            maybeFinish();
          });
          ws.on("error", reject);
          count += 1;
          if (onFile) onFile(count);
        }
      }

      function finishEntry() {
        if (entryStream) {
          entryStream.end();
          entryStream = null;
        }
        entry = null;
      }
    });

    gunzip.on("end", () => {
      ended = true;
      if (entryStream) entryStream.end(); // 兜底收尾
      maybeFinish();
    });
  });
}

/** 解析 512 字节 tar 头。返回 null（结束块）或条目描述对象 */
function parseHeader(header, destDir) {
  // 全零块 = 归档结束标记
  if (header.every((b) => b === 0)) return null;

  const str = (start, len) => header.subarray(start, start + len).toString("utf-8").replace(/\0.*$/, "").trim();
  let name = str(0, 100);
  const sizeOct = str(124, 12);
  const size = sizeOct ? parseInt(sizeOct, 8) : 0;
  const typeflag = String.fromCharCode(header[156] || 48);
  const prefix = str(345, 155);
  if (prefix) name = `${prefix}/${name}`;

  const mode = parseInt(str(100, 8) || "644", 8) || 0o644;

  if (!name) return { type: "skip", size, remaining: size, pad: (512 - (size % 512)) % 512 };
  const norm = name.replace(/\\/g, "/").replace(/^\.\//, "");
  // 安全检查：拒绝空路径、绝对路径与穿越
  if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) return { type: "skip", size, remaining: size, pad: (512 - (size % 512)) % 512 };
  const absPath = path.join(destDir, norm);

  // 目录：typeflag 5，或路径以 / 结尾（普通标志的目录条目）
  const isDir = typeflag === "5" || name.endsWith("/");
  if (isDir) {
    // 同步建目录：后续文件条目的写入流依赖父目录已存在（解压是同步解析循环）
    mkdirSync(absPath, { recursive: true });
    return { type: "dir", size, remaining: size, pad: 0 };
  }
  // 仅处理普通文件（typeflag 0 / \0；硬链 1、符号链 2、其他 specials 跳过）
  if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "") return { type: "skip", size, remaining: size, pad: (512 - (size % 512)) % 512 };
  mkdirSync(path.dirname(absPath), { recursive: true });
  return { type: "file", size, remaining: size, pad: (512 - (size % 512)) % 512, absPath, mode };
}
