# shirone-admin

Shirone 博客内容仓的在线写作工具：浏览器表单化编写文章与动态 → 服务端生成规范 Markdown → 经 GitHub Contents API 推送内容仓。服务器**不做任何构建**（构建由主题代码仓的 GitHub Actions 完成）。

## 特性

- **零构建**：纯 Node.js ESM，`node server.js` 直接运行，内存占用约 50MB
- **本地镜像**：仓库内容缓存到服务器磁盘（一次性拉取分支 tarball），列表/详情读取零 GitHub 请求；右上角 GitHub 按钮手动触发同步（带进度与结果反馈），启动时自动预热；保存/删除后自动回写镜像
- **草稿暂存**：勾选"草稿"后保存按钮变为"暂存"——内容只存服务器 `.drafts/` 目录，不推 GitHub；取消勾选再保存即自动发布（暂存图片一并搬运，`draft` 字段自动清除）
- **字段 UI 化**：分类/标签/心情/九宫格图/开关全部点选，无需手写 frontmatter
- **时间自动注入**：服务器按当前 UTC 时刻生成 `publishedAt`（naive UTC 串）与 `published`（站点时区日历日期），恒过主题构建期同日校验
- **编辑保护**：合并式更新，`encrypted/password` 等未知字段原样保留，`published/publishedAt` 不被覆盖
- **扩展语法对话框**：提示容器、字段参数卡片、代码标签页、代码树、步骤条、折叠面板、视频嵌入、GitHub 卡片、图片画廊等 10+ 种主题扩展语法的表单化插入
- **图片上传**：拖拽/粘贴/按钮上传，文章图存文章目录（相对引用，享构建期优化），动态图存 `public/images/albums/`
- **DEV 下载模式**：本地验证专用——保存不推送，直接下载 `.md` 或打包 `.zip`（含图片），解压进内容仓即可本地预览
- **单密码认证**：HMAC 签名 HttpOnly Cookie，登录失败限速（10 次锁 15 分钟）

## 快速开始（DEV 模式，本地验证）

```powershell
cd shirone-admin
npm install
Copy-Item .env.example .env.development
# 编辑 .env.development：设置 ADMIN_PASSWORD、DEV_MODE=1、DEV_CONTENT_DIR 指向本地内容仓
npm run dev
```

打开 `http://localhost:3777`，新建文章并插入图片后点"保存"，浏览器会下载 zip；解压覆盖到内容仓对应目录，在主题代码仓运行 `pnpm content:validate` 验证格式。

## 生产部署

### 1. 生成 GitHub Token

到 GitHub → Settings → Developer settings → [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new)：

- **Repository access**：仅选择你的内容仓（如 `Nyaecho/blog-content`）
- **Permissions**：Contents → **Read and write**
- 建议设置过期时间并定期轮换

### 2. 配置环境变量

```bash
cp .env.example .env
```

```ini
PORT=3777
ADMIN_PASSWORD=<强密码>
GITHUB_TOKEN=<github_pat_xxx>
GITHUB_OWNER=Nyaecho
GITHUB_REPO=blog-content
GITHUB_BRANCH=main
SITE_TIMEZONE=Asia/Shanghai
DEV_MODE=0

# 健康数据页（可选；配置后自动同步，向导上传凭证即可）
MIHEALTH_DB=/srv/shirone-admin/health-data/mihealth.db
```

> `SITE_TIMEZONE` 必须与博客 `config/site.yaml` 的 `timeZone` 一致（默认 `Asia/Shanghai`）。

### 3. 运行

```bash
npm install
npm start
```

### 4. systemd 守护（推荐）

```bash
sudo cp deploy/shirone-admin.service /etc/systemd/system/
# 编辑 User/WorkingDirectory 后：
sudo systemctl daemon-reload
sudo systemctl enable --now shirone-admin
```

### 5. 反向代理（HTTPS 建议）

服务默认只监听 `127.0.0.1`（`HOST=127.0.0.1`），公网一律经同机 nginx 反代访问。
前端已全量相对路径化，可挂在任意子路径下（前缀由反代剥离，管理平台无感知）：

```
# 博客域下挂 /blog-admin/（与博客、健康数据接口同域，不暴露独立服务器地址）
location /blog-admin/ {
    proxy_pass http://127.0.0.1:3777/;   # 末尾斜杠 = 剥离前缀
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
}
```

- 管理平台：`https://<博客域名>/blog-admin/`
- 健康数据（博客 /health/ 页运行时取数）：`https://<博客域名>/blog-admin/api/health/snapshot`

Cookie 在 HTTPS 反代下自动追加 `Secure`（检测 `x-forwarded-proto`）。
## 目录约定

| 内容 | 仓库路径 | 引用方式 |
| --- | --- | --- |
| 文章正文 | `content/posts/<slug>/index.md` | slug 即 URL |
| 文章图片 | `content/posts/<slug>/*` | `./filename` 相对引用 |
| 动态 | `content/moments/YYYY-MM-DD[-后缀].md` | `published` 必含时分秒 |
| 动态图片 | `public/images/albums/<YYYY-MM-DD>/*` | 根路径引用 |

## 自动部署 hook（可选）

本工具内置部署 webhook：主题仓 GitHub Actions 构建完成后，把 `dist` 以 orphan commit
强推到主题仓 `deploy` 分支，随后 POST `/api/deploy/hook`（HMAC-SHA256 签名验证）；
本工具在服务器上对 `/www/wwwroot/blog`（稀疏检出 dist 的克隆）执行
`git fetch --depth 1` + `git reset --hard`，Actions 侧轮询 ticket 直至 `done`。

### 服务器一次性初始化

```bash
# 稀疏克隆：只检出 deploy 分支的 dist/
git clone --filter=blob:none --no-checkout --single-branch \
     --branch deploy https://github.com/Nyaecho/Shirone.git /www/wwwroot/blog
cd /www/wwwroot/blog && git sparse-checkout set dist
# 私有仓需配置拉取凭据（credential store 或 remote 内嵌只读 token）
```

nginx 站点 root 指向 `/www/wwwroot/blog/dist`。

### 配置（.env）

```ini
# 与主题仓 Secret DEPLOY_HOOK_SECRET 一致的随机串
DEPLOY_SECRET=<openssl rand -hex 32>
# 服务器上 blog 仓库路径
DEPLOY_DIR=/www/wwwroot/blog
# 构建产物分支
DEPLOY_BRANCH=deploy
```

### 主题仓 Secrets（GitHub Actions）

| Secret | 值 |
| --- | --- |
| `CONTENT_REPO_TOKEN` | 对 `Nyaecho/blog-content` 只读的 PAT |
| `DEPLOY_TOKEN` | 对 `Nyaecho/Shirone` Contents 可写的 PAT（推 deploy 分支） |
| `DEPLOY_HOOK_URL` | `https://admin.<域名>/api/deploy/hook` |
| `DEPLOY_HOOK_SECRET` | 与服务器 `DEPLOY_SECRET` 相同 |

### 回滚

服务器上直接操作：

```bash
cd /www/wwwroot/blog
git fetch origin deploy --depth=50   # 拉取更早历史
git log --oneline                    # 找到目标版本
git reset --hard <commit>
```

## 时间注入规则

| 字段 | 写入值 | 示例 |
| --- | --- | --- |
| 文章 `publishedAt` | naive UTC 串（服务器当前时刻） | `"2026-09-03 07:41:23"` |
| 文章 `published` | 该时刻在站点时区的日历日期 | `2026-09-03` |
| 文章 `updatedAt` / `updated` | 勾选"刷新更新时间"时成对生成 | 同上规则 |
| 动态 `published` | naive UTC 串（必含时分秒） | `"2026-09-03 07:41:23"` |

北京时间 0:00–8:00 发布时 UTC 已跨天，`published` 按站点时区取日历日期，保证主题构建期 `publishedAt` 同日校验恒通过。

## API 一览（均需 Cookie 认证）

```
POST   /api/login            { password }
POST   /api/logout
GET    /api/me               模式信息
GET    /api/posts            文章列表
GET    /api/posts/:slug      文章详情（frontmatter + body + sha）
POST   /api/posts            新建文章 { form, body }
PUT    /api/posts/:slug      更新文章（merge 保留未知字段）
DELETE /api/posts/:slug
GET    /api/moments          动态列表
GET    /api/moments/:id
POST   /api/moments          发布动态
PUT    /api/moments/:id
DELETE /api/moments/:id
POST   /api/upload           multipart 图片上传（target=post|moment）
```

### 健康数据代理（公开只读，无需登录）

博客静态页 `/health/` 的运行时数据源。**数据同步内置于本服务**（自 mihealth-api
完整移植：RC4-drop1024 签名加密客户端、时间窗翻页回填、水位增量、401 免密自愈、
每小时进程内定时器），部署只需：`.env` 配 `MIHEALTH_DB` → 向导上传凭证 →
自动建库自动回填自动增量，**零 cron 零 Python 依赖**。库与 mihealth-api
完全同构（records/dedup/sync_state），可互换接管。

```
GET /api/health/status     库配置与各数据键覆盖情况（运维排查）
GET /api/health/snapshot   聚合快照：近 N 天步数(按站点时区日聚合)、
                           24h 心率/压力序列(降采样≤240点+统计)、
                           近 N 晚睡眠摘要(主会话+全部会话)+最近一夜分期段
```

- 内存缓存 `MIHEALTH_CACHE_TTL_MS`（默认 10 分钟）；库暂不可用时降级返回上次快照；
- 每 IP 每分钟 30 次限流；日历日边界按 `SITE_TIMEZONE` 切，与博客时区一致；
- 统计天数固定 `MIHEALTH_DAYS`（前端零可变参数）；
- 同步键：steps/sleep/heart_rate/stress/spo2/calories（`lib/mihealth-sync.js` 的
  `SYNC_KEYS` 可扩展）；
- **库体积控制（可选）**：全量历史积累到几百 MB 也只影响磁盘不影响查询速度；需要控制时
  运行 `node scripts/prune-mihealth.mjs --db <mihealth.db> --keep-days 7`（删除 N 天前行，
  云端保留全量，凭证在位时下次同步即按需拉回近段）。
- 本地验证：`node scripts/test-mihealth.mjs`（mock 库快照断言）。

### 小米凭证部署（需登录）

顶栏「♥ 健康凭证」按钮。**推荐通道：本地登录 + 上传**（小米 2FA 验证态绑定
浏览器 cookie，服务器端无法跨客户端续接，实测 2026-10）：

1. 本机 mihealth-api 目录运行 `python login.py --user <账号> --password <密码>`
   （或已登录态 `python login.py --refresh`），生成/更新 `config.json`；
2. 向导里粘贴 config.json **全文** → 「上传 / 登录」→ 凭证写入
   `MIHEALTH_DB` 同目录 `config.json`（600，与 mihealth-api 同构）；
3. 日常续期：向导「⟳ 免密续期」一键换新（pass_token 有效期约 1~2 个月），
   无需再走登录。

备用通道（折叠区）：服务器上直接账号密码登录（图片验证码行内重试；
2FA 官方页人工验证后 resume——该通道受小米验证态 cookie 绑定限制，
不保证可用）。

```
GET  /api/mi-login/status    凭证概况（脱敏：是否部署/凭证年龄/有无 passToken）
POST /api/mi-login/upload    上传凭证 JSON（config.json 全文，校验必需字段）
POST /api/mi-login/password  备用：服务器账号密码登录（captcha/2fa 分步返回）
POST /api/mi-login/resume    备用：官方页人工验证后服务端续接
POST /api/mi-login/refresh   pass_token 免密续期
```

## 安全注意事项

- `ADMIN_PASSWORD` 使用强随机值；泄漏后立即更换（Cookie 签名同时失效）
- 建议将工具部署在内网或添加额外的反代层认证（如 Cloudflare Access）
- GitHub Token 仅授予内容仓的 Contents 权限，不授予 admin/workflow 权限
- 生产环境务必通过 HTTPS 反代访问

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 保存报 409 | 目标文件已存在（并发冲突），刷新列表后重试 |
| 推送后站点未更新 | 检查内容仓 `trigger-build.yml` 是否已启用（见内容仓文档 04-deployment） |
| 401 持续出现 | Cookie 过期（7 天），重新登录 |
| 429 | 登录失败过多，15 分钟后自动解锁 |
