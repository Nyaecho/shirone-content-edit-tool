# shirone-admin 前端架构

零构建 vanilla ESM，无打包器——浏览器直接加载模块。职责分层如下。

## 模块依赖图

```
app.js（视图层主体：登录/外壳/三列表/三编辑器/快捷键）
 ├─ api-client.js   API 请求封装 + toast 提示
 ├─ state.js        全局运行时状态（state 单例 + timelineData）
 ├─ utils.js        纯工具：qs/esc/assetUrl/slug 建议/插入光标/下载触发
 ├─ tags.js         标签输入与候选复用 + 分类自绘候选
 ├─ uploads.js      图片上传链路（正文图/九宫格/封面覆盖式组件）
 ├─ pin-bottom.js   卡片钉底控制器（三编辑器统一）
 ├─ autosave.js     自动保存控制器（debounce → 服务器暂存层）
 ├─ moods.js        心情清单（内联 SVG）——UI 用 SVG，frontmatter 存 iconify 名
 ├─ inline-images.js  CodeMirror 行内图片（lineWidget）
 ├─ ext-preview.js  主题扩展语法近似预览（previewRender 前置转换）
 └─ dialogs.js      扩展语法插入对话框（表单 → 语法文本）
```

## 后端模块（server.js 入口）

```
server.js            Express 挂载：/api（认证路由）+ /api/health（公开）+ 静态托管
routes/api.js        认证/文章/动态/时间线/上传/草稿暂存 CRUD/同步/部署
routes/health.js     健康数据快照（公开只读）+ /alert 警示点
services/posts.js    文章业务（列表/详情/创建/更新/删除）
services/moments.js  动态业务
services/timeline.js 时间线业务（data/timeline.ts 整文件读写）
services/taxonomy.js 标签/分类聚合
lib/config.js        环境配置（.env 单次读取）
lib/auth.js          HMAC Cookie 认证 + 限速
lib/store.js         存储统一出口（生产 GitHub+镜像 / DEV 本地 fs）
lib/staging.js       服务器暂存层（草稿快照 + 图片 + 引用计数 + 吸收搬运）
lib/github.js        GitHub Contents API 封装
lib/mirror-store.js  仓库磁盘镜像
lib/sync.js          镜像同步（tarball 拉取解压）
lib/content.js       frontmatter 生成/解析/合并（时间注入核心规则）
lib/mihealth*.js     健康数据同步与凭证续期（自动定时，不经写作台）
```

## 关键数据流

### 保存语义（用户拍板，勿改）
| 动作 | 推 git？ | 行为 |
|---|---|---|
| 自动保存 / Ctrl+S | ✗ | 只存服务器暂存层（`STAGING_DIR`，默认 `.staging/`） |
| 点「暂存」 | ✓ | `draft: true` 推送（生产站点隐藏） |
| 点「发布」 | ✓ | 无 draft 推送 |
| 图片上传 | ✗ | 进暂存区，推送时按正文引用搬运 |
| 封面图 | ✗ | 固定 `cover.<ext>` 暂存，换格式自动清旧残留 |

推送成功后 `absorbAfterPush`（routes/api.js）吸收：搬运引用图片 → 清暂存快照。

### 暂存恢复（乐观锁）
打开编辑器时 `GET /drafts/:kind/:id`，仅当快照的 `baseSha`（保存时文件 sha）
与当前文件 sha 一致才恢复——文件已被推送更新过的暂存视为过期，不再覆盖表单。
（历史教训：曾用时间字符串比较，老文章无 updatedAt 时恒真导致空暂存清空标题/草稿勾选）

## 添加新功能的落点

- **新心情**：`public/moods.js` 追加 `{ icon, label, svg }`
- **新工具栏按钮**：`app.js` 的 EasyMDE `toolbar` 数组；图标用 **FA4** 合法类名
  （FA5 名如 `fa-highlighter` 不存在，会渲染空白）
- **新扩展语法**：生成端 `dialogs.js`；预览端 `ext-preview.js` 加渲染分支
- **新编辑器视图**：`index.html` 加 template + `app.js` 渲染函数 + 侧栏导航按钮
- **新 API**：`routes/api.js` 加路由；前端统一走 `api-client.js` 的 `api()`

## 断点体系（public/style.css）

| 断点 | 形态 |
|---|---|
| ≥1280 | 双列 320px + 编辑器 |
| 961–1279 | 双列 260px |
| 769–960 | 双列 220px；侧栏 rail 48px |
| ≤768 | 单列；侧栏变顶部横条；卡片钉底禁用 |
| ≤400 | 留白再压缩 |
| 触控/短视口 | 热区放大 / 容器内滚 |

## DEV 模式

`DEV_MODE=1`：读本地内容仓、保存动作转浏览器下载（.md/.zip）、上传走内存暂存、
自动保存停用。验证流程见 README「快速开始」。
