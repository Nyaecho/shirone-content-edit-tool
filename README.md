# shirone-admin

Shirone 博客内容仓的在线写作工具：浏览器表单化编写文章与动态 → 服务端生成规范 Markdown → 经 GitHub Contents API 推送内容仓。服务器**不做任何构建**（构建由主题代码仓的 GitHub Actions 完成）。

## 特性

- **零构建**：纯 Node.js ESM，`node server.js` 直接运行，内存占用约 50MB
- **无仓库克隆**：经 GitHub Contents API 直接写文件，服务器无状态
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

工具的 Cookie 在检测到 `x-forwarded-proto: https` 时自动追加 `Secure`。以 Caddy 为例：

```
admin.example.com {
    reverse_proxy localhost:3777
}
```

nginx 参考：

```nginx
server {
    listen 443 ssl;
    server_name admin.example.com;
    location / {
        proxy_pass http://127.0.0.1:3777;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 目录约定

| 内容 | 仓库路径 | 引用方式 |
| --- | --- | --- |
| 文章正文 | `content/posts/<slug>/index.md` | slug 即 URL |
| 文章图片 | `content/posts/<slug>/*` | `./filename` 相对引用 |
| 动态 | `content/moments/YYYY-MM-DD[-后缀].md` | `published` 必含时分秒 |
| 动态图片 | `public/images/albums/<YYYY-MM-DD>/*` | 根路径引用 |

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
