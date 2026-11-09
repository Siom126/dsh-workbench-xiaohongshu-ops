# 小红书运营工作台 · DSH Desktop 工作台包

Muse 里「小红书运营工作台」的 DSH Desktop 移植版。按《Workbench Development
Standard》（2026-10-27）打成真正的 DSH 工作台包，安装后在 DSH Desktop 的
Workbenches 切换区使用。

> **数据从空开始。** 包里不含 Muse 工作台的任何数据（不含「樱花的春天」账号、
> 20 篇笔记、监测账号等）。安装后请重新扫码登录、重新拉取。

## 安装

1. 在 DSH Desktop 里安装本包的 `.tgz`（Agent 调 `install_local_workbench`，
   传入本包的绝对路径；只有返回 `applied` 才算成功）。
2. 按顶部横幅点 **Restart now**，或选 Harness → Restart Harness，重启 Harness。
   通常只需重启 Harness，不必完全退出 DSH Desktop。
3. 重启后展开左侧栏，点左上角 **Workbenches** 右侧的当前名称/切换区域，
   选择「小红书运营工作台」。新本地工作台加载后会自动进入切换菜单，
   没有单独的「Add」按钮；若未出现，去 Workbench Market → Installed 找标
   「Local」的条目确认运行状态。

## 包含什么

- `package.json`：`dsh.bundle.patch`、`dsh.client.platform: "web"`、
  `dsh.client.inject: ["dsh-desktop-workbenches"]`、`exports["./client"]` 齐全；
  服务端入口 `dsh/index.js`，客户端单文件 `lib/client.js`。
- `cordis.patch.yml`：把插件挂进 Cordis（id `xiaohongshu-ops`）。
- `dsh/index.js`：Cordis 插件入口，Config 用 Schemastery schema；
  业务接口统一挂在 `/api/xiaohongshu-ops/` 前缀下。
- `packages/core/`：宿主无关的业务核心，对外只暴露 `createCore({ storage, llm, bridge, clock, logger })`
  一个工厂；core 里不出现 `ctx.` 与 `window.`。
  - `packages/core/store.mjs`：本地存储的表逻辑（11 张表、列定义、默认值与 DDL、
    各表读写方法）；数据库访问走注入的 `storage` 接口，宿主实现在 `dsh/adapters.mjs`
    （Node ≥ 22 的 `node:sqlite`，WAL；SQLite 不可用时降级同目录 JSON）。
  - `packages/core/gate.mjs`、`packages/core/generate.mjs`、`packages/core/bridge.mjs`、
    `packages/core/scheduler.mjs`：统一登录门禁、笔记生成、浏览器桥接协议、60 秒握手调度。
  - `packages/core/index.mjs`：`createCore` 工厂（绑定 store / llm / bridge / clock）。
- `dsh/adapters.mjs`：宿主适配层（`createNodeStorage` / `createClock` / `createLogger`），
  由 `dsh/index.js` 接线注入 core。
- `src/client.jsx` → `scripts/build-client.mjs` → `lib/client.js`：
  单文件 React 业务面板，`window.__ModuleLoader__.load` 注册，
  `customFrame: true` 整页布局。

## 移植清单（与 Muse 工作台一一对应）

| Muse 工作台 | DSH 包 | 说明 |
| --- | --- | --- |
| 5 个页面：总览 / 生成 / 笔记库 / 数据 / 设置 | `src/client.jsx` 同名 5 页 | 流程不变；侧边栏底部「刷新全部数据」按钮保留 |
| 48 个服务端动作 | `dsh/index.js` 全部 49 个动作 | 另加 1 个聚合端点 `getstate`（见下） |
| 11 张表（schema.ts 的 10 张业务表 + 迁移表） | `packages/core/store.mjs` 同名 11 张表 | SQLite 实现，字段与口径一致 |
| 统一登录门禁 `resolveLoginGate` / `getLoginGate` | `packages/core/gate.mjs` 原样移植 | 唯一判定入口；state 枚举 unknown/checking/valid/expired/needs_scan；24 小时过期；inconclusive 握手绝不翻门禁 |
| 每 60 秒握手 `xhs-login-handshake-60s` | `packages/core/scheduler.mjs` + `handshakeloginsession` | 同名定时任务；设置页显示最近一次握手的完成情况（状态/时间/说明） |
| `generateNote` 生文 | `packages/core/generate.mjs` | 同一套 system 提示词与 draft schema（标题 20 字内、正文 300–600 字、标签 5–8 个、配图说明与图片一一对应）；入库截断与 imageIds 规则不变；**不生成图片** |
| 笔记库：草稿编辑 / 发布改状态 / 已发布不打开 | 同上 | 发布后 status 由 draft 改 published 并写 publishedAt；已发布笔记在工作台里不打开任何页面，只能点「在小红书打开原笔记」 |
| 监测账号体系（填主页链接添加，可多个） | 同上 | 与绑定账号彻底分开存储与展示；切换监测账号不改动绑定账号 |
| 指标快照（点赞/收藏/分享/评论） | 同上 | 未知指标存 `null`、显示 `—`，绝不编造、不拿 0 顶替 |
| 数据文件夹路径 | 设置页只记录路径 | 只记录 `dataDirLabel`，不读取、不展示图片；**不含 Muse 侧实测路径，不硬编码** |
| 原笔记链接保留 `xsec_token` | 同上 | 干净链接在已登录状态下试了三次也打不开（300031）；令牌过期报 300017/300031 不是笔记被删；点开前有说明，并给「去账号主页点这篇」「重新获取新链接」两个恢复入口 |
| 账号头像 | 同一头像组件 + `avatarUrl` 字段 | 读到真实头像就全站用同一张；未读到时显示昵称首字占位，不编造头像 |
| 一键刷新全部数据 | `refreshalldata` | 一次刷新绑定账号资料和登录态、笔记、每个监测账号的数据，并重载本地已存数据；刷新中显示「正在刷新…」并禁用 |

## 适配（相对 Muse 工作台改动的地方）及原因

1. **新增聚合端点 `getstate`（第 49 个动作）。**
   客户端 `loadAll` / `reloadNotes` 只调它一次取齐全部状态。原因有二：
   一是客户端组件读的字段名（`xiaohongshuId`、`profileUrl`、`following`、
   `coverUrl`、`url`、`accountNickname`、监测账号的 `notes`/`snapshots`、
   门禁的 `status: 'verified'`、握手的 `status/at/message`）与服务端行映射
   的字段名不一致，服务端在 `getstate` 里一次归一化，比改遍 5 个页面稳妥；
   二是笔记库要的指标/封面/链接分散在 `notes`、`fetched_notes`、`assets`、
   `metric_snapshots` 四张表里，`getstate` 在服务端拼好，客户端不用多路拉取。
   原有的 48 个动作一个不少，仍可单独调用。
2. **已拉笔记镜像进笔记库。** Muse 的 `saveFetchedNotes` 会把已拉笔记同时写进
   `notes` 表（`source='fetched'`、状态 `published`），所以笔记库里是 20 篇已拉
   笔记 + 草稿。DSH 版在 `savefetchednotes` 里补了同一镜像逻辑（按 `source_url`
   去重），`savenoteimages` 回填配图后同步镜像的 `fetched_images_json`，
   `cleanupunverifiedfetchednotes` 清理时同步删镜像。否则笔记库只能看到草稿。
3. **客户端一律 POST。** 服务端全部动作只注册了 POST，GET 会 404；
   无参调用也以空对象 POST。
4. **`start*` 动作只派发、不拉取。** Muse 里这些动作派发浏览器任务、由任务调
   `save*` 回写；DSH 里没有同一个浏览器会话，见「明确限制」。
5. **拉取上限按 20 篇。** Muse 拉取任务提示词写「最多 10 篇」，但
   `saveFetchedNotes` / `saveMonitoredAccountFetch` 允许数组 `max(20)`，
   实际也拉到了 20 篇；DSH 版统一按 20 篇。
6. **package.json 的 `dsh.client.inject` 与客户端 `inject` 不是同一个东西。**
   前者写 `["dsh-desktop-workbenches"]`（宿主注入点），后者 export
   `['desktopWorkbenches']`（客户端要的服务名）。跨平台账号看板就是这么写的，
   不是名字不一致，无需改。

## 明确限制（请先读完再用）

1. **扫码登录与页面拉取需要浏览器扩展，本包 v1 未内置扩展。**
   Muse 里的扫码登录、读账号主页拉笔记、读笔记配图、60 秒握手确认登录态，
   靠的都是 Muse 自身的浏览器会话；DSH 工作台标准全文没有浏览器操作能力
   （无 browser 一词），也没有对应的官方接口可以照搬。
   本包按跨平台账号看板（beianbai/cross-platform-account-dashboard）的有据可查
   模式预留了桥接层（`packages/core/bridge.mjs`）：用户在自己的 Chrome/Edge/
   Firefox 里装一个 MV3 浏览器扩展，工作台生成一次性配对码（2 分钟有效）粘贴
   到扩展完成配对；平台登录在用户自己的浏览器里完成；扩展只读读取已登录页面。
   **v1 尚未交付这个扩展**，所以当前版本：
   - 「唤起浏览器扫码登录」会打开小红书登录页（`requestqrlogin` 返回 `url`，
     客户端自动 `window.open`），扫码本身在浏览器里完成；
   - 但扫码后自动读取账号信息、拉取笔记、拉取监测账号、补拉配图、握手确认，
     都会返回一条明确的中文原因（「浏览器扩展未配对，无法……；请先配对浏览器
     扩展。」），**不会假装成功**，也不会静默失败；
   - `save*` 回写接口（`saveloggedinaccountinfo`、`savefetchednotes`、
     `savemonitoredaccountfetch`、`savenoteimages`、`savehandshakeresult` 等）
     已全部实现并经冒烟验证，扩展接好后即可回写，数据模型不用改。
   - 扩展不读取密码或 Cookie，不调用平台私有 API，不下载视频/音频文件。
2. **笔记生成的模型推理待实测。** `generateNote` 优先用宿主挂载的模型服务
   （`ctx.llm`，上游 `dsh-llm` 的 provider-neutral 调用）；宿主未挂载时返回
   `MODEL_NOT_AVAILABLE`，并**不建草稿**（冒烟已验证）。工作台标准全文未写
   工作台插件能否/如何 inject 模型服务、宿主是否已挂载、provider/model 如何由
   用户配置，所以这条路径在真实 DSH Desktop 上**尚未验证**，不得视为已跑通。
   另一条已验证的路线是经 DSH 会话发提示词让 Agent 生成并调工具回写
   （yangsong 模式），如需可后续接。
3. **`ctx.connection.fetch.register` 的调用形态来自示例仓库，需目标版本确认。**
   标准只规定接口挂自己前缀 `/api/<workbench-id>/…`，未规定注册签名；本包按
   beianbai 实测写法 `register({ path, methods: [method], requestBody: 'buffered',
   fetch: handler })`。若目标 Desktop 版本签名不同，只改 `dsh/index.js` 里的
   `registerRoute` 一处。
4. **60 秒握手在 Muse 侧自 2026-11-08 11:28 后未真正完成过。** 当时多次
   `getLoginGate` 调用里 `lastHandshakeAt` 停在 2026-11-08T03:28:39Z，
   `handshakeStatus` 恒为 `checking`、`browserState` 恒为 `unknown`，而
   `handshakeLoginSession` 同期仍在被调用。可能只是预览字段滞后，也可能握手
   近几小时未真正完成；门禁按设计保持 valid、不误报掉登录。DSH 版在设置页把
   握手状态/时间/说明直接展示出来，完没完成一眼可见；未配对扩展时握手返回
   `notStarted` 并写明原因。
5. **本地 SQLite 是自选实现，不是标准能力。** 标准全文未提及 SQLite；本包用
   Node ≥ 22 内置 `node:sqlite`（WAL，不可用时降级同目录 JSON；同一 SQLite
   文件只留一个写者）。数据写配置目录（`root`，即 `dshHomePath`），卸载不得
   删除用户数据。
6. **没有生图功能。** 工作台只生文（标题/正文/标签/配图说明），配图只能用你
   自己的图片：生成页从设备选文件（浏览器端压缩到最大 1600px 转 JPEG 后上传
   挂到草稿上），或手填图片文件路径（只取文件名放进提示词，图本身不被读取、
   也不挂载）。生成页参考附图列表初始为空。
7. **其余 Muse 侧已知未解决项，原样继承：** 每篇笔记目前只有封面 1 张图，
   多图图库未知；第 3–20 篇的收藏/分享/评论数、发布时间、摘要未知时显示 `—`；
   账号头像在 Muse 侧至今未读到（`avatarUrl` 为空时显示昵称首字占位）；
   2026-11-07 发布的「秋假探店」草稿审核结果仍未确认。

## 开发与验证

```bash
# 构建客户端（bun 或 node 脚本均可，二者等价）
node scripts/build-client.mjs
# 语法检查
npm run check
# 打包（无 pnpm 时用 npm pack）
npm pack --pack-destination ~/workspace/dsh-workbench/
tar -tzf ~/workspace/dsh-workbench/dsh-workbench-xiaohongshu-ops-0.1.0.tgz
```

冒烟测试（脚本在 `/tmp`，不进包；需临时给 `@deepseek-ai/schemastery` 打桩，
因本地无 node_modules）：服务端 41 项（含 `getstate` 归一化、镜像进笔记库、
配图同步、门禁丢弃、cleanup 同步删镜像）、客户端 43 项（含构建脚本自检与
5 个页签、loader 标记），均通过（0 失败）。真实 DSH Desktop 宿主实测尚未做
（见限制 2、3）。

## What to do next

1. 在 DSH Desktop 里安装本包（`install_local_workbench`），重启 Harness，
   在 Workbenches 切换区打开工作台，确认 5 个页面正常显示（数据从空开始）。
2. 配对浏览器扩展（或先手动扫码登录），验证绑定账号信息与前 20 篇笔记能拉取、
   笔记库出现已拉笔记镜像、封面能显示。
3. 在真实宿主上验证 `ctx.llm` 生成路径与 `fetch.register` 注册形态，
   再决定是否把生成与拉取标为已跑通。
