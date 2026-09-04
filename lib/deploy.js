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
import { config } from "./config.js";

const execFileP = promisify(execFile);

/** 单次 git 子进程超时（秒）：国内服务器连 GitHub 慢，给定上限防挂起 */
const GIT_TIMEOUT_MS = 120_000;

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

/** 受理部署请求：登记 ticket 并异步执行，立即返回 ticket。 */
export function acceptDeploy({ repository, sha }) {
  const ticket = crypto.randomBytes(12).toString("hex");
  const rec = {
    state: "running",
    startedAt: new Date().toISOString(),
    repository,
    sha,
  };
  tickets.set(ticket, rec);
  runDeploy(rec).catch((err) => {
    rec.state = "failed";
    rec.error = err.message;
    console.error(`[deploy] 部署失败 (${sha}):`, err.message);
  });
  return ticket;
}

export function getTicketState(ticket) {
  return tickets.get(ticket) || null;
}

/** 执行一次拉取部署：fetch --depth 1 + reset --hard，稀疏检出由仓库自身配置完成。 */
async function runDeploy(rec) {
  // git 索引不支持并发写；上一个部署还在跑时直接判失败，等下一次触发
  if (deploying) {
    rec.state = "failed";
    rec.error = "上一个部署仍在进行中（git 不可并发操作），请稍后重试";
    return;
  }
  deploying = true;
  const dir = config.deploy.dir;
  const branch = config.deploy.branch;
  try {
    console.log(`[deploy] 开始拉取: ${dir} (${branch}) @ ${rec.sha}`);
    await git(dir, ["fetch", "origin", branch, "--depth=1"]);
    await git(dir, ["reset", "--hard", "FETCH_HEAD"]);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    rec.state = "done";
    rec.head = head;
    console.log(`[deploy] 完成: HEAD=${head}`);
  } finally {
    deploying = false;
  }
}

/** 在部署目录异步执行 git 命令；超时或失败时抛带 stderr 的 Error。 */
async function git(dir, args) {
  try {
    // 异步执行 + 超时：同步版本（execFileSync）会阻塞事件循环，
    // git 挂起时整个 admin（含 webhook 响应）都会冻结——线上事故实证。
    const { stdout } = await execFileP(
      "git",
      ["-c", `safe.directory=${dir}`, "-C", dir, ...args],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    return stdout;
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().slice(0, 300);
    const timeoutNote = err.killed ? " [git 超时被强杀——检查服务器到 GitHub 的连通性]" : "";
    throw new Error(`git ${args[0]} 失败: ${detail}${timeoutNote}`);
  }
}

