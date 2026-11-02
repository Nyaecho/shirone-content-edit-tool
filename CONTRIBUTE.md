# 开发规范（CONTRIBUTE）

面向在 shirone-admin（仓库目录 `shirone-content-edit-tool`）上做开发的贡献者。
本文是**规范与流程**的单一来源；架构/模块/数据流事实归 [docs/architecture.md](./docs/architecture.md)，
用户功能与操作归 [README.md](./README.md)——本文只引用不复写。

## 1. 项目定位

Shirone 博客内容仓的在线写作工具：浏览器表单化编写文章/动态/时间线 → 服务端生成规范
Markdown → 经 GitHub Contents API 推送内容仓。服务器不做任何构建（构建由主题代码仓的
GitHub Actions 完成）。零构建 vanilla ESM 前端，后端运行时依赖仅 5 个
（express / gray-matter / yaml / multer / jszip）。功能全貌见 README「特性」。

## 2. 环境搭建

```powershell
cd shirone-content-edit-tool
npm install
Copy-Item .env.example .env.development
# DEV 最小集：ADMIN_PASSWORD、DEV_MODE=1、DEV_CONTENT_DIR 指向本地内容仓
npm run dev        # http://localhost:3777
```

- **Node ≥ 22.13.0**（`package.json` engines）：`lib/mihealth*.js` 顶层 import `node:sqlite`，更早版本启动即崩
- 生产环境变量一律以 **`.env.example` 为权威清单**；新增 env 必须三处同步：
  `lib/config.js` 读取 + `.env.example` 条目 + README（用户可见时）
- `server.js` 启动前跑 `validateConfig()`，缺配置直接退出并列出缺失项

### QA 冒烟台（行为回归工具，不在本仓库内）

本工作区维护了一套冒烟台（随工作区迭代，**不属于仓库内容**）：

```bash
bash /e/Project/blog/.qa/run-smoke.sh <tag>
```

自动重建内容 fixture → 起服务 → 跑断言 → 保存快照基线（`baseline-<tag>.json`）与
fixture 清单。用法约定：

- 改 **server 端行为**的变更，改后跑一次并与既有基线 diff：断言 0 失败，快照
  diff 为空或仅含工单声明的预期增量；
- 纯前端改动不影响 API 面，冒烟可免，但 `node --check` 与人工走查必做。

### scripts/*.mjs 的定位

| 脚本 | 性质 | 用途 |
| --- | --- | --- |
| `scripts/test-mihealth.mjs` | 测试 | 构造 mock mihealth.db → 起服务 → fetch 快照断言（无需真实凭证） |
| `scripts/test-timeline2.mjs` | 测试 | timeline 服务全链路离线自测（DEV_MODE 下驱动真实代码路径，写不落盘） |
| `scripts/prune-mihealth.mjs` | 运维工具（非测试） | 删除 N 天前健康数据行控制库体积，手动按需执行 |

## 3. 目录与模块约定

模块清单、依赖图、关键数据流、断点体系**单源见
[docs/architecture.md](./docs/architecture.md)**，本文不复写目录树。分层纪律：

1. **存储读写只经 `lib/store.js`**：路由层永不直接 import `github.js` / `dev-store.js` /
   `mirror-store.js`；`lib` 的无状态能力模块（staging / content / geocode 等）可按需使用
2. **依赖单向**：`routes → services → lib`；services 不 import routes；lib 不 import
   services/routes（当前代码即如此，勿引入反向边）
3. **内容格式规则集中在 `lib/content.js`**（frontmatter 合并、时间注入、路径计算）——
   改格式先读懂该文件头部的时间语义注释
4. **前端模块单向依赖**：`app.js` 是唯一组合根；跨模块可变共享状态只放 `public/state.js`
   （`state` 单例 + `timelineData`），纯工具只放 `public/utils.js` 且不反向依赖业务模块
5. 所有端点统一 `{ ok, data }` / `{ ok: false, error }` 包装 + `handleError`
   （400 输入非法 / 404 / 409 并发冲突 / 500）；新路由记得挂 `requireAuth`
   （公开端点除外，参考 `routes/health.js` 的限流与 CORS 头）
6. 写操作成功后回写镜像 + `invalidateTaxonomies()` 失效标签缓存，否则列表/标签池与远端不一致
7. 任何接受路径参数的端点必须防路径穿越（`resolveIn` 模式或白名单，参考 `/api/asset`）

## 4. 命名与风格（按现状归纳）

- **lib = 能力模块**，按能力命名（store / staging / sync / deploy / geocode / content /
  concurrency…）；**services = 领域模块**，按内容域命名（posts / moments / timeline /
  taxonomy）；routes 仅 `api.js`（认证+业务）与 `health.js`（公开健康数据）两个文件
- **public 按职责拆分**为单例模块（app / api-client / state / utils / tags / uploads /
  autosave / dialogs / ext-preview / inline-images / moods / pin-bottom），新前端能力
  先考虑放进既有模块，确属新职责再立新文件
- 全部使用**命名导出**（无 default export）；import 用 `import * as` 或具名
- 注释、报错文案、commit 描述均用**中文**；报错文案面向用户时给可操作指引
  （例：凭证报错指向 config.json 放置方式，不指向已下线的界面）
- 样式集中在 `public/style.css`：无预处理器；断点集中在文件尾部 `@media` 区
  （1280 / 960 / 768 / 400 + 触控/短视口）；深浅色跟随系统（`prefers-color-scheme`）
- 日期时间值全链路 naive 字符串 `YYYY-MM-DD HH:mm:ss`；前端不发 ISO 带时区串

## 5. Commit 规范

格式：`type(scope): 中文描述`，一个逻辑组一个 commit。

- **type**：`feat` / `fix` / `refactor` / `docs` / `chore`
- **scope**：小写连字符，取自改动域。历史已用：
  `sync` `deploy` `ui` `ux` `editor` `api` `time` `mi-login` `mi-sync` `health`
  `staging` `proxy` `timeline` `tags` `prune` `mirror` `draft` `dedupe` `cleanup`
  以及 docs 类 `readme` `env` `contribute` `architecture` `comments`
- 描述一行说清**行为变化**；误删恢复、契约回归要在描述里点名（先例：
  `a64baba` 「恢复 GITHUB_API_BASE/GITHUB_WEB_BASE——f4c6b75 重构误删 4cc689a 代理支持」）
- 多个 bug 同属一个逻辑组可合并一个 commit（先例：暂存层三连修复 B2+B3+B4）

## 6. 变更纪律（硬性约定）

1. **前端共享状态单一事实源**：跨模块可变状态只能放 `public/state.js`（对象属性可变），
   禁止模块级 `const` 别名后重新赋值——别名与原对象脱钩后视图瘫痪且难察觉
   （教训：`timelineCache` 别名瘫痪时间线在线编辑，`5cb740d` 回归 `97b5575`）
2. **扩展语法三方对齐**：`dialogs.js`（生成端）与 `ext-preview.js`（预览端）的语法口径
   必须以主题仓 `Shirone/src/plugins/markdown/manifest.json`（已支持语法单一索引）为准，
   改动前先核对主题解析器实现（教训：tabs 三方互不认，发布产物渲染不出标签页，`ce2bad7`）
3. **时间字段契约**（README「时间注入规则」表为用户口径）：
   - 文章 `published` = 站点时区日历日期（写出口恒为日期形态，date-only 老文章的
     `00:00:00` 规整回日期，`ca69201`）
   - 文章 `publishedAt` = naive UTC 全串；动态 `published` 必含时分秒
   - YAML 序列化时时间戳**剥引号输出**，Astro 内容层才能解析成 Date 过 `z.date()`（`38678c8`）
   - `published/publishedAt/alias/permalink` 不被表单覆盖；未知 frontmatter 字段原样保留
4. **暂存层契约**：快照恒为四键 `{ form, body, images, baseSha }`（`lib/staging.js`
   saveDraft 对展平形态有归一化防御，但新代码不得依赖防御）；推送吸收
   `absorbDraft` 与快照解耦——extraPaths 不依赖快照存在（教训：新建动态带图发布丢图，
   `1457d5b`）
5. **server 端行为变更必须跑冒烟快照对比**（见「2. 环境搭建」）；**前端变更必须
   `node --check` + 人工走查**；两类改动都不引入构建步骤与框架
6. **删除/重构以 commit 历史为契约**：删除任何已声明功能（端点、env、按钮）必须在
   commit message 写明，并同步修改全部文档与 `.env.example`（教训：`f4c6b75` 重构静默
   吞掉 `4cc689a` 的代理功能，三个月后 `a64baba` 才恢复）
7. **环境变量新增**走「2. 环境搭建」的三处同步；废弃的 env 在 `.env.example`
   改注遗留语义（先例：`DRAFTS_DIR`），不直接删除条目

## 7. 测试与验证

现状：**仓库无 lint / test 框架**（无 eslint/jest/vitest 配置），主题仓承担内容格式与
端到端测试。本仓库的验证闸门：

1. **语法**：`node --check <file>`——改动过的每个 js/mjs 都跑（前端 ESM 同样适用）
2. **行为回归**：QA 冒烟台（`bash /e/Project/blog/.qa/run-smoke.sh <tag>`，工作区维护，
   见「2. 环境搭建」）；server 行为变更必跑
3. **专项脚本**：健康数据 `node scripts/test-mihealth.mjs`；时间线
   `DEV_MODE=1 DEV_CONTENT_DIR=<内容仓> node scripts/test-timeline2.mjs`
4. **内容格式**：DEV 下载 zip 解压进内容仓后，主题仓 `pnpm content:validate` 预检
5. **发布前走查**（人工）：登录 → 三编辑器各建改一篇（含图片/草稿切换）→ 暂存恢复
   → 同步按钮 → 健康页快照 → DEV 下载 zip 解压验证

## 8. 发布与回滚

- **发布**：服务器拉取代码 → `npm install` → `systemctl restart shirone-admin`
  （systemd 单元 `deploy/shirone-admin.service`：`ExecStart=node --env-file=.env server.js`，
  `MemoryMax=256M`，`Restart=on-failure`；部署时需改单元内 User/WorkingDirectory）
- **回滚**：`git reset --hard <上一 tag 或 commit>` + `systemctl restart shirone-admin`
- 镜像/缓存无需备份：`.mirror/` 是纯缓存，删掉重启即重建（GitHub 仓库是唯一事实源）；
  `.staging/` 是暂存层，删掉只丢未推送的自动保存
- 站点产物回滚（`/www/wwwroot/blog` 的 dist 稀疏检出）见 README「自动部署 hook → 回滚」

## 9. 已知登记项

登记在案、暂不处理的事项（动它们之前先与 owner 确认）：

- **`.tmp-cred2/`**：mock 凭证遗留（仅一个 `config.json`），全仓零代码引用，待 owner 决定删除
- **`GET /api/asset` 长缓存**：响应带 `Cache-Control: private, max-age=86400`——文件名含
  内容 hash，正常换图 = 新文件名无影响；**同名替换图片**时浏览器 24h 内可能命中旧缓存，
  替换图片请使用新文件名
