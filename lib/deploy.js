/**
 * 部署服务：接收主题仓 Actions 的 webhook 通知，稀疏拉取构建产物分支。
 *
 * 流程（与 Shirone 仓 .github/workflows/deploy.yml 配对）：
 *   1. Actions 构建完成 → 把 dist 以 orphan commit 强推到主题仓 deploy 分支
 *      → POST /api/deploy/hook（HMAC 签名）；
 *   2. 本模块校验签名后立即返回 ticket，后台执行部署任务；
 *   3. 部署任务：在服务器上的 blog 仓库（DEPLOY_DIR）执行
 *      `git fetch origin deploy --depth 1` + `git reset --hard FETCH_HEAD`；
 *      仓库克隆时已 `sparse-checkout set dist`，nginx root 指向 DEPLOY_DIR/dist 不变；
 *   4. Actions 侧轮询 GET /api/deploy/hook?ticket=... 直至 done / failed。
 *
 * 安全：
 *   - webhook 用 X-Signature（HMAC-SHA256，密钥 = .env 的 DEPLOY_SECRET）验证；
 *   - ticket 查询同样要求携带签名（GET 以空串计算，与 POST 侧约定一致）；
 *   - 签名不匹配 → 401，日志记录来源 IP。
 *
 * 服务器初始化（一次性）：
 *   git clone --filter=blob:none --no-checkout --single-branch \
 *        --branch deploy <主题仓URL> /www/wwwroot/blog
 *   cd /www/wwwroot/blog && git sparse-checkout set dist
 *   私有仓需在服务器上配置拉取凭据（credential store 或 remote 内嵌 token）。
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const execFileP = promisify(execFile);

/** git 子进程超时（秒）：服务器连 GitHub 慢（deploy 分支为 orphan force-push，
 *  depth=1 fetch 每次全量拉产物），120s 不够；统一 300s，两路径一致 */
const GIT_TIMEOUT_MS = 300_000;

/** 部署内自动重试次数：慢网下首次 fetch 常超时，重试命中已热的对象缓存后即成功 */
const DEPLOY_ATTEMPTS = 3;

/** 部署任务表：ticket → { state, error?, startedAt, sha? } */
const tickets = new Map();

/** 部署互斥：git 索引不支持并发写，同时只允许一个部署任务 */
let deploying = false;

export function deployEnabled() {
  return Boolean(config.deploy.secret);
}

/** 校验请求体签名；返回 true/false。timingSafe 防时序攻击。 */
export function verifySignature(rawBody, signatureHeader) {
  if (!deployEnabled() || !signatureHeader) return false;
  const provided = String(signatureHeader).replace(/^sha256=/, "");
  const expected = crypto
    .createHmac("sha256", config.deploy.secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 受理部署请求：登记 ticket 并异步执行（含自动重试），立即返回 ticket。 */
export function acceptDeploy({ repository, sha }) {
  const ticket = crypto.randomBytes(12).toString("hex");
  const rec = {
    state: "running",
    startedAt: new Date().toISOString(),
    repository,
    sha,
  };
  tickets.set(ticket, rec);
  runDeployWithRetry(rec).catch((err) => {
    rec.state = "failed";
    rec.error = err.message;
    console.error(`[deploy] 部署失败 (${sha}):`, err.message);
  });
  return ticket;
}

export function getTicketState(ticket) {
  return tickets.get(ticket) || null;
}

export function isDeploying() {
  return deploying;
}

/**
 * 手动重试部署（admin 右上角按钮触发，Cookie 认证，不走 webhook HMAC）。
 * 复用 webhook 的拉取逻辑；git 超时放宽（Actions 触发的那次可能因慢网超时失败，
 * 手动重试往往第二次命中已热的对象缓存 + 更长时限即可成功）。
 * 返回 { ticket } 或 { error }。
 */
export function manualDeploy() {
  if (!fs.existsSync(config.deploy.dir)) {
    return { error: `部署目录不存在: ${config.deploy.dir}（服务器未初始化稀疏克隆？）` };
  }
  if (deploying) {
    return { error: "已有部署正在进行（webhook 或手动），请稍后再试" };
  }
  const ticket = crypto.randomBytes(12).toString("hex");
  const rec = {
    state: "running",
    startedAt: new Date().toISOString(),
    repository: "manual-retry",
    sha: null,
    manual: true,
  };
  tickets.set(ticket, rec);
  runDeployWithRetry(rec).catch((err) => {
    rec.state = "failed";
    rec.error = err.message;
    console.error("[deploy] 手动部署失败:", err.message);
  });
  return { ticket };
}

/** 带重试的部署：慢网首次超时常见，退避后重试命中已热缓存即成功。 */
async function runDeployWithRetry(rec) {
  let lastErr;
  for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS; attempt++) {
    try {
      await runDeploy(rec, { attempt, totalAttempts: DEPLOY_ATTEMPTS });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < DEPLOY_ATTEMPTS) {
        const backoffMs = attempt * 15_000; // 15s / 30s 退避
        console.warn(`[deploy] 第 ${attempt}/${DEPLOY_ATTEMPTS} 次尝试失败（${err.message.slice(0, 120)}），${backoffMs / 1000}s 后重试`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

/** 执行一次拉取部署：fetch --depth 1 + reset --hard，稀疏检出由仓库自身配置完成。 */
async function runDeploy(rec, opts = {}) {
  // git 索引不支持并发写；上一个部署还在跑时直接判失败，等下一次触发
  if (deploying) {
    rec.state = "failed";
    rec.error = "上一个部署仍在进行中（git 不可并发操作），请稍后重试";
    return;
  }
  deploying = true;
  const dir = config.deploy.dir;
  const branch = config.deploy.branch;
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  try {
    // 清理被 SIGKILL 强杀的 git 残留的 index.lock（死锁，不清则后续部署全失败）。
    // 安全性：deploying 互斥保证此刻没有本服务发起的 git 在跑；该仓库在服务器上
    // 仅由 admin 操作，外部 git 进程占锁的可能性可忽略。
    const lockPath = path.join(dir, ".git", "index.lock");
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      console.warn(`[deploy] 已清理残留的 git 锁: ${lockPath}（上次 git 被超时强杀所致）`);
    }
    const attemptNote = opts.totalAttempts > 1 ? ` [尝试 ${opts.attempt || 1}/${opts.totalAttempts}]` : "";
    console.log(`[deploy] 开始拉取: ${dir} (${branch}) @ ${rec.sha ?? "(手动)"}${attemptNote}`);
    await git(dir, ["fetch", "origin", branch, "--depth=1"], timeoutMs);
    await git(dir, ["reset", "--hard", "FETCH_HEAD"], timeoutMs);
    const head = (await git(dir, ["rev-parse", "HEAD"], timeoutMs)).trim();
    rec.state = "done";
    rec.head = head;
    console.log(`[deploy] 完成: HEAD=${head}`);
  } finally {
    deploying = false;
  }
}

/** 在部署目录异步执行 git 命令；超时或失败时抛带 stderr 的 Error。 */
async function git(dir, args, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    // 异步执行 + 超时：同步版本（execFileSync）会阻塞事件循环，
    // git 挂起时整个 admin（含 webhook 响应）都会冻结——线上事故实证。
    const { stdout } = await execFileP(
      "git",
      ["-c", `safe.directory=${dir}`, "-C", dir, ...args],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" },
    );
    return stdout;
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().slice(0, 300);
    const timeoutNote = err.killed ? " [git 超时被强杀——检查服务器到 GitHub 的连通性]" : "";
    throw new Error(`git ${args[0]} 失败: ${detail}${timeoutNote}`);
  }
}

