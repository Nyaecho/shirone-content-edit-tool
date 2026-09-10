# 贡献指南与架构导览

面向想在 shirone-admin 上做开发的贡献者。读完本文你应该能回答三个问题：**代码在哪里、请求怎么流、改动要动哪些文件**。

## 项目定位

Shirone 博客内容仓的在线写作工具：浏览器表单化编写文章/动态 → 服务端生成规范 Markdown → 经 GitHub Contents API 推送内容仓。服务器不做任何构建（构建由主题代码仓的 GitHub Actions 完成）。

- **零构建**：纯 Node.js ESM（`node server.js` 直接跑），前端 vanilla ESM 无框架无打包器
- **运行时依赖仅 5 个**：express / gray-matter / yaml / multer / jszip

## 目录结构速查

```
shirone-admin/
├── server.js            入口：Express 挂载 + 静态托管 + SPA 兜底 + 启动校验
├── routes/
│   └── api.js           全部 HTTP 端点（唯一路由文件）
├── services/            业务层（列表/详情/增删改查的编排）
│   ├── posts.js         文章
│   ├── moments.js       动态
│   └── taxonomy.js      标签/分类聚合（生产模式带磁盘缓存）
├── lib/                 基础设施（与业务无关的能力层）
│   ├── config.js        环境配置读取与校验（改配置项先看这里）
│   ├── auth.js          单密码认证 + HMAC Cookie + 登录限速
│   ├── store.js         ★ 存储统一出口（读镜像/写 GitHub 的分流全在这）
│   ├── github.js        GitHub Contents API 封装（生产存储）
│   ├── dev-store.js     DEV 存储适配器（读本地 fs、写转下载）
│   ├── mirror-store.js  本地镜像的磁盘读写（防路径穿越、写后回写）
│   ├── sync.js          tarball 拉取 + 流式解压 + 原子替换镜像
│   ├── content.js       ★ 内容格式核心（frontmatter 生成/解析/合并、时间注入、路径计算）
│   ├── image-staging.js DEV 模式内存图片暂存
│   ├── draft-store.js   已退役的旧草稿迁移工具（可安全忽略）
│   ├── deploy.js        部署 webhook（HMAC 验签 + 服务器 git 拉取）
│   └── geocode.js       逆地理编码（nominatim/amap）
├── public/              前端（零构建，直接静态托管）
│   ├── index.html       全部视图的 <template> + 对话框/顶灯 DOM
│   ├── app.js           ★ 前端主逻辑（视图切换、编辑器、上传、标签、同步）
│   ├── dialogs.js       Markdown 扩展语法对话框（10+ 种插入表单）
│   ├── style.css        全部样式（Material 风格、深浅色跟随系统）
│   └── vendor/          EasyMDE 等第三方库
├── deploy/              systemd 服务文件
└── tests/               参见主题仓 CI 说明
```

带 ★ 的三个文件是改动最频繁的位置。

## 分层架构

```
浏览器（public/app.js）
   │  fetch /api/*（JSON；上传为 multipart）
   ▼
routes/api.js            认证 → 参数校验 → 调 service → 统一 { ok, data } 包装
   ▼
services/*               业务编排：路径计算、frontmatter 合并、冲突检测
   ▼
lib/store.js             存储统一出口（一行 if 分流 DEV / 生产）
   ├─ DEV：dev-store.js  读本地内容仓 fs；写返回 devDownload → 路由层转浏览器下载
   └─ 生产：
       ├─ 读：mirror-store.js（本地镜像优先，未命中回退 github.js）
       └─ 写：github.js（推 Contents API）→ 成功后回写 mirror-store.js
```

关键约定：

1. **路由层只 import `lib/store.js`**，永不直接碰 github.js / dev-store.js
2. **所有内容格式规则集中在 `lib/content.js`**（frontmatter 合并策略、时间注入、slug 校验、路径计算）——改格式先读该文件头部的时间语义注释
3. **服务无状态镜像**：镜像（`.mirror/current/`）只是缓存；GitHub 仓库永远是唯一事实源，删掉 `.mirror/` 重启即重建

## 请求流程走读（以"保存文章"为例）

1. 前端 `savePost()` 收集表单 → `PUT /api/posts/:slug`
2. `routes/api.js` → `postsService.updatePost()`
3. service 读现有文件（`store.getFile`：生产走镜像 → 未命中走 GitHub API）
4. `parseMarkdown` 解析 → `mergePostFrontmatter` 合并（未知字段原样保留、`published` 永不覆盖）
5. `buildMarkdown` 组装 → `store.putFile`（生产：先推 GitHub，成功后回写镜像 + 推进 meta.sha）
6. 写入后 `invalidateTaxonomies()` 使标签缓存失效（下次 `/taxonomies` 按新内容懒重建）
7. 响应 `{ ok, data: { message, commitUrl, ... } }` → 前端 toast + 自动返回列表页

## 图片链路（上传 → 预览 → 管理）

```
上传：POST /api/upload（multer 内存存储，20MB 上限，仅 image/*）
  ├─ 文章图 → content/posts/<slug>/<MMDD-hash>.<ext>（正文相对引用 ./xxx）
  └─ 动态图 → public/images/albums/<YYYY-MM-DD>/<MMDD-hash>.<ext>（根路径引用）
  生产：直接 putFile 推仓库；DEV：暂存内存（image-staging.js）

预览：GET /api/asset?path=<仓库相对路径>（Cookie 认证的图片代理）
  └─ store.getBinaryFile：镜像/内容仓读取 → 未命中回退 GitHub raw
     镜像因内容仓 .gitattributes 的 export-ignore 不含 public/，
     所以动态图在生产模式通常走 raw 回退——这是有意设计（镜像只服务 content/）

前端三处消费同一代理：
  - 已传图缩略图卡片（drawUploadList）
  - 动态九宫格（drawMomentImages：/images/... → public/images/...）
  - EasyMDE 预览（previewRender 重写 img src：./xxx → content/posts/<slug>/xxx）
```

## 数据持久化清单

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| 仓库内容镜像 | `.mirror/current/`（仅 content/） | 同步时整体替换；写操作即时回写 |
| 标签/分类聚合缓存 | `.mirror/taxonomies.json` | 同步成功或内容写入后失效，下次请求懒重建 |
| DEV 图片暂存 | 进程内存（TTL 2h） | 保存时打包进下载 zip |
| 会话 | HMAC 签名 Cookie（7 天） | 无服务端状态 |

同步语义（生产模式）：**写直达远端、读走本地镜像、手动同步拉远端**——"同步"按钮的唯一目的是把别处（如 git push）对仓库的更新拉进镜像，写路径从不依赖它。

## DEV 模式与生产模式

同一份代码，`DEV_MODE=1` 切换存储实现（见 `lib/store.js`）：

| 操作 | DEV | 生产 |
| --- | --- | --- |
| 读 | 本地内容仓 fs（`DEV_CONTENT_DIR`） | 镜像优先 → GitHub API |
| 写 | 返回 `devDownload` → 浏览器下载 .md/.zip | 推 GitHub + 回写镜像 |
| 同步按钮 | 隐藏 | 显示 |

本地验证：`npm run dev` → 保存下载 zip → 解压进内容仓 → 主题仓 `pnpm content:validate` 验格式。

## 本地开发

```powershell
cd shirone-admin
npm install
Copy-Item .env.example .env.development
# 编辑 .env.development：ADMIN_PASSWORD、DEV_MODE=1、DEV_CONTENT_DIR 指向本地内容仓
npm run dev
# 打开 http://localhost:3777
```

无 lint / test 配置（逻辑测试在主题仓的 tests/ 下，CI 说明见主题仓 docs/ci-and-node-tests.md）。改动后直接刷新页面即可（前端零构建）。

## 改动指南

| 想做的事 | 要动的文件 |
| --- | --- |
| 加/改 API 端点 | `routes/api.js`（注意统一 `{ ok, data }` 包装 + `handleError`） |
| 加文章 frontmatter 字段 | `lib/content.js`（merge/new 两个函数 + 白名单）→ `services/posts.js` 列表摘要 → `public/app.js` 表单回填与 collect |
| 改编辑器工具栏/对话框 | `public/app.js`（EasyMDE 配置）→ 需要表单则加 `public/dialogs.js` |
| 改内容仓路径约定 | `lib/content.js` 的 `postFilePath` / `momentAssetPath` 等（路径规则全部在这） |
| 加环境变量 | `lib/config.js` + `.env.example` + README |
| 动镜像/缓存策略 | `lib/mirror-store.js` + `lib/sync.js` |

### 必须遵守的约定

1. **时间字段全链路 naive 字符串**（`YYYY-MM-DD HH:mm:ss`，无引号写出）——这是为通过 Astro 的 `z.date()` 校验，详见 `lib/content.js` 头部注释，改动前务必读懂
2. **未知 frontmatter 字段原样保留**（加密文章的 `encrypted/password` 等依赖此行为）
3. **`published/publishedAt/alias/permalink` 不被表单覆盖**
4. **镜像操作必须走 `resolveLocal` 防路径穿越**；任何接受路径参数的端点要做同样的校验（参考 `/api/asset` 的白名单）
5. **写操作成功后回写镜像 + 失效标签缓存**，否则列表/标签池会与远端不一致
6. 前端保持 vanilla ESM、零构建——不引入框架与打包器是本项目的设计决策

## 部署形态（生产）

```
systemd（deploy/shirone-admin.service）
  └─ node server.js（.env 注入配置）
       ├─ 反代（Caddy/nginx，x-forwarded-proto → Cookie 自动 Secure）
       ├─ .mirror/（磁盘缓存，含 taxonomies.json）
       └─ GitHub Contents API（Fine-grained PAT，仅内容仓）
```

内存占用约 50MB；systemd 单元限制了 256MB。自动部署 webhook（`/api/deploy/hook`）是独立可选功能，配置见 README 的部署章节。
