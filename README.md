# 小红书运营工作台 · DSH Desktop 工作台包

Muse 里「小红书运营工作台」的 DSH Desktop 移植版。按《Workbench Development
Standard》（2026-10-27）打成真正的 DSH 工作台包，安装后在 DSH Desktop 的
Workbenches 切换区使用。

> **数据从空开始。** 包里不含 Muse 工作台的任何数据（不含「樱花的春天」账号、
> 20 篇笔记、监测账号等）。安装后请重新扫码登录、重新拉取。

## v0.2.0 新增（相对 v0.1.0）

- **重构第 1 点（7 步）全部移植**：双层边栏（笔记专区—发布日历/笔记制作；数据专区—竞对监控/热点资讯/留资管理；账号管理独立顶层），旧页面（总览/笔记库/发布/设置）按新设计重建，不保留原样。
- **发布日历**：只算主账号；拉取改为逐篇开详情页读发布时间与收藏/分享/评论，相对标签按拉取日换算成绝对日期；新增回填管线（带进度，不删数据）。
- **笔记制作**：固定风格三档（种草/评测/探店，默认种草）；发布形态预览（注明“发布预览、不会发布”）；热点资讯跳过来预填；文件夹选择读图（上限 9 张）；AI 生图三后端（Muse/DSH/API，OpenAI 兼容接口）。
- **竞对监控**：拉取只取最新 5 篇；新增通知（笔记上新、点赞绝对数超 5，每篇只报一次，等于 5 不报，首次拉取只建基线）；页面改成 A 方案（顶部对比条 + 密集表格）。
- **热点资讯**：关键词最多 20 个；小红书间隔 1/3/6/12/24 小时可选；X 固定 12 小时一次、每次最多 50 条；15 分钟定时任务到期触发双源检索并清理超 7 天资讯。
- **留资管理**：只监控不回复（私信只读消息页列表、不点开会话、绝不发送；评论提醒用评论数增量比对）。
- **账号管理**：首次使用自动打开小红书扫码绑定 + X 登录页（只触发一次）；X 登录态随机浏览检查（无法确定时存为“没能确定”，绝不猜测）；完整生图 API 管理（默认后端、基础 URL、模型、Key 保存/清除、清空全部、测连通性；Key 绝不回显）；账号信息与登录态合成同一条账号记录（`login_session` 表已删除）。
- **登录态重校准**：门禁三态（已登录/未登录/无法确定）带原因与最近确认时间；握手与 info-fetch 各 10 分钟硬超时，无回写记“无法确定”，绝不永远“正在确认”；记录态与握手结论分开存，失败不再静默改写已确认记录。
- **扫码修复**：用户主动点登录按钮时，立即在用户自己浏览器里打开小红书（`window.open`），同时服务端强制派发全新扫码任务（一次性去重键）；info-fetch 加 10 分钟超时自清；新增“在浏览器打开小红书”直达链接与“我已扫码，重新读取账号信息”按钮。
- **共用会话架构**：用户可见浏览器里确认的登录，经 `reportSharedSessionLogin` 写回后成为门禁正式结论；任务浏览器的握手掉线结论推翻不了更新的共用登录。共用浏览器已登录但任务浏览器未登录时，拉取/补图/补日期/监测/私信/热点不再派撞墙任务，改为登记到账号管理页“共用会话请求清单”，由主代理在已登录浏览器里完成并写回；发布走同一条路。
- **界面**：theme.css 重写为完整三层令牌（品牌红 50–900 全阶、暖灰 50–950、中文优先字体栈、4px 间距）；标题与指标数字 30px、卡片内边距 20px、分区距 48px；主内容区 85% 宽度居中（桌面端，手机端满宽）；竞对表格自适应。
- 动作 49 → 83 个，表 11 → 16 张；全库统一毫秒时间戳。

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
  业务接口统一挂在 `/api/xiaohongshu-ops/` 前缀下；83 个服务端动作。
- `packages/core/`：宿主无关的业务核心，对外只暴露 `createCore({ storage, llm, bridge, clock, logger })`
  一个工厂；core 里不出现 `ctx.` 与 `window.`。
  - `packages/core/store.mjs`：本地存储的表逻辑（16 张表、列定义、默认值与 DDL、
    各表读写方法）；数据库访问走注入的 `storage` 接口，宿主实现在 `dsh/adapters.mjs`
    （Node ≥ 22 的 `node:sqlite`，WAL；SQLite 不可用时降级同目录 JSON）。
  - `packages/core/gate.mjs`、`packages/core/generate.mjs`、`packages/core/bridge.mjs`、
    `packages/core/scheduler.mjs`：统一登录门禁（三态）、笔记生成（三档风格 + 生图三后端）、浏览器桥接协议、双定时任务（60 秒握手 + 15 分钟热点 tick）。
  - `packages/core/index.mjs`：`createCore` 工厂（绑定 store / llm / bridge / clock）。
- `dsh/adapters.mjs`：宿主适配层（`createNodeStorage` / `createClock` / `createLogger`），
  由 `dsh/index.js` 接线注入 core；`node:sqlite` 用具名导出。
- `src/client.jsx` → `scripts/build-client.mjs` → `lib/client.js`：
  单文件 React 业务面板，`window.__ModuleLoader__.load` 注册，
  `customFrame: true` 整页布局；6 个页面（发布日历 / 笔记制作 / 竞对监控 /
  热点资讯 / 留资管理 / 账号管理）。

## 移植清单（与 Muse 工作台一一对应）

| Muse 工作台 | DSH 包 | 说明 |
| --- | --- | --- |
| 6 个页面：发布日历 / 笔记制作 / 竞对监控 / 热点资讯 / 留资管理 / 账号管理 | `src/client.jsx` 同名 6 页 | 双层边栏；侧边栏底部「刷新全部数据」按钮保留 |
| 83 个服务端动作 | `dsh/index.js` 全部 83 个动作 | 含聚合端点 `getstate`（见下） |
| 16 张表 | `packages/core/store.mjs` 同名 16 张表 | SQLite 实现，字段与口径一致；全库毫秒时间戳；`login_session` 已删除 |
| 统一登录门禁 `resolveLoginGate` / `getLoginGate` | `packages/core/gate.mjs` 原样移植 | 三态 verdict（logged_in/logged_out/unknown）带原因与最近确认时间；握手与 info-fetch 各 10 分钟硬超时；共用会话结论优先于任务浏览器握手；QR 每个过期事件只唤起一次 |
| 每 60 秒握手 `xhs-login-handshake-60s` + 每 15 分钟热点 tick | `packages/core/scheduler.mjs` | 双定时任务；账号管理页显示门禁与握手状态 |
| `generateNote` 生文（三档风格） | `packages/core/generate.mjs` | 同一套 system 提示词与 draft schema（标题 20 字内、正文 300–600 字、标签 5–8 个、配图说明与图片一一对应）；风格种草/评测/探店（默认种草）；禁止编造价格、品牌功效数据和不存在的经历细节；无模型时返回 `MODEL_NOT_AVAILABLE` 且不建草稿 |
| `generateImage` 生图（三后端） | 同上 | Muse 后端走宿主模型、DSH 后端走宿主生图能力、API 走 OpenAI 兼容接口；无 Key/无能力时明确提示，绝不假装生成 |
| 笔记制作：草稿编辑 / 发布改状态 / 已发布不打开 | 同上 | 发布后 status 由 draft 改 published 并写 publishedAt；已发布笔记在工作台里不打开任何页面，只能点「在小红书打开原笔记」 |
| 发布日历（只算主账号） | 同上 | 月/周视图；日期未知只进归档不进格子；回填管线带进度 |
| 竞对监控（最新 5 篇 + 两种通知） | 同上 | 与绑定账号彻底分开存储与展示；通知只两种（笔记上新、点赞绝对数超 5），全在工作台内（弹窗 + 铃铛 + 可回看列表） |
| 热点资讯（双源） | 同上 | 关键词 ≤ 20；小红书间隔可选；X 固定 12h/50 条；资讯保留 7 天；每条有「做成笔记」跳转预填 |
| 留资管理（只监控不回复） | 同上 | 私信只读列表、评论增量比对；页面上无任何回复入口 |
| 账号管理（首次登录 + X 检查 + 生图 API + 共用会话清单） | 同上 | 账号信息与登录态同一条记录；Key 只显示已保存状态和更新时间，绝不回显 |
| 指标快照（点赞/收藏/分享/评论） | 同上 | 未知指标存 `null`、显示 `—`，绝不编造、不拿 0 顶替 |
| 数据文件夹路径 | 账号管理页只记录路径 | DSH 本地可按目录直接读文件（Muse 侧用浏览器目录选择器）；不硬编码路径 |
| 原笔记链接保留 `xsec_token` | 同上 | 干净链接在已登录状态下试了三次也打不开（300031）；令牌过期报 300017/300031 不是笔记被删；点开前有说明，并给「去账号主页点这篇」「重新获取新链接」两个恢复入口 |
| 账号头像 | 同一头像组件 + `avatarUrl` 字段 | 读到真实头像就全站用同一张；未读到时显示昵称首字占位，不编造头像 |
| 一键刷新全部数据 | `refreshalldata` | 一次刷新绑定账号资料和登录态、笔记、每个监测账号的数据，并重载本地已存数据；刷新中显示「正在刷新…」并禁用 |

## 适配（相对 Muse 工作台改动的地方）及原因

1. **新增聚合端点 `getstate`。**
   客户端 `loadAll` / `reloadNotes` 只调它一次取齐全部状态。v0.2.0 里 `getstate`
   新增六块：热点 feed、留资监控、竞对通知 + 未读数、共用会话清单 + pending 数、
   生图设置、onboarding。原有的动作一个不少，仍可单独调用。
2. **已拉笔记镜像进笔记库。** Muse 的 `saveFetchedNotes` 会把已拉笔记同时写进
   `notes` 表（`source='fetched'`、状态 `published`），所以笔记库里是已拉
   笔记 + 草稿。DSH 版在 `savefetchednotes` 里补了同一镜像逻辑（按 `source_url`
   去重），`savenoteimages` 回填配图后同步镜像的 `fetched_images_json`，
   `cleanupunverifiedfetchednotes` 清理时同步删镜像。否则笔记库只能看到草稿。
3. **客户端一律 POST。** 服务端全部动作只注册了 POST，GET 会 404；
   无参调用也以空对象 POST。
4. **`start*` 动作只派发、不拉取。** Muse 里这些动作派发浏览器任务、由任务调
   `save*` 回写；DSH 里没有同一个浏览器会话，见「明确限制」。无扩展时返回
   明确的中文原因；共用会话请求登记为“待处理”，不派撞墙任务。
5. **监测拉取只取最新 5 篇。** Muse 侧重构第 1 点改动；DSH 同步（任务提示 +
   服务端截断双保险，旧笔记不删）。
6. **package.json 的 `dsh.client.inject` 与客户端 `inject` 不是同一个东西。**
   前者写 `["dsh-desktop-workbenches"]`（宿主注入点），后者 export
   `['desktopWorkbenches']`（客户端要的服务名）。跨平台账号看板就是这么写的，
   不是名字不一致，无需改。
7. **时间表示：全库毫秒时间戳。** v0.2.0 统一为毫秒时间戳（与 Muse 一致）；
   v0.1.0 用 ISO 文本，升级时 `dsh/adapters.mjs` 负责把旧数据迁移过来。
8. **共用会话在 DSH 里无主代理可代劳。** `shared_session_requests` 只能呈现为
   “待处理”，`reportSharedSessionLogin` 是宿主/扩展调用的桥接回调；没有它，
   门禁绝不能声称已登录。

## 明确限制（请先读完再用）

1. **扫码登录与页面拉取需要浏览器扩展，本包 v0.2.0 未内置扩展。**
   Muse 里的扫码登录、读账号主页拉笔记、读笔记配图、60 秒握手确认登录态，
   靠的都是 Muse 自身的浏览器会话；DSH 工作台标准全文没有浏览器操作能力
   （无 browser 一词），也没有对应的官方接口可以照搬。
   本包按跨平台账号看板（beianbai/cross-platform-account-dashboard）的有据可查
   模式预留了桥接层（`packages/core/bridge.mjs`）：用户在自己的 Chrome/Edge/
   Firefox 里装一个 MV3 浏览器扩展，工作台生成一次性配对码（2 分钟有效）粘贴
   到扩展完成配对；平台登录在用户自己的浏览器里完成；扩展只读读取已登录页面。
   **v0.2.0 尚未交付这个扩展**，所以当前版本：
   - 「唤起浏览器扫码登录」会打开小红书登录页（`requestqrlogin` 返回 `url`，
     客户端自动 `window.open`），扫码本身在浏览器里完成；
   - 但扫码后自动读取账号信息、拉取笔记、拉取监测账号、补拉配图、握手确认，
     都会返回一条明确的中文原因（「浏览器扩展未配对，无法……；请先配对浏览器
     扩展。」），**不会假装成功**，也不会静默失败；
   - 共用会话请求清单在 DSH 里只能呈现为“待处理”，没有主代理去履行；
     `reportSharedSessionLogin` 只有宿主/扩展能调，调之前门禁绝不能声称已登录；
   - `save*` 回写接口已全部实现并经冒烟验证，扩展接好后即可回写，数据模型不用改。
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
   `handshakeLoginSession` 同期仍在被调用。v0.2.0 的门禁已重校准为三态
   （已登录/未登录/无法确定）带原因与最近确认时间，握手 10 分钟硬超时后记
   “无法确定（任务无回写）”，不再永远“正在确认”；共用会话结论优先于任务
   浏览器握手。DSH 版在账号管理页把门禁与握手状态直接展示出来，完没完成一眼
   可见；未配对扩展时握手返回 `notStarted` 并写明原因。
5. **本地 SQLite 是自选实现，不是标准能力。** 标准全文未提及 SQLite；本包用
   Node ≥ 22 内置 `node:sqlite`（WAL，不可用时降级同目录 JSON；同一 SQLite
   文件只留一个写者）。数据写配置目录（`root`，即 `dshHomePath`），卸载不得
   删除用户数据。
6. **生图三后端依赖宿主能力。** Muse 后端走宿主模型、DSH 后端走宿主生图能力、
   API 后端走 OpenAI 兼容接口（Key 在账号管理页保存/清除，绝不回显）。宿主
   未提供对应能力时明确提示不可用。真实宿主上的生图通道尚未验证。
7. **其余 Muse 侧已知未解决项，原样继承：** 每篇笔记目前只有封面 1 张图，
   多图图库未知；18 篇笔记缺发布日期，需在发布日历里跑一次回填；
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
tar -tzf ~/workspace/dsh-workbench/dsh-workbench-xiaohongshu-ops-0.2.0.tgz
```

冒烟测试（脚本在 `/tmp`，不进包）：服务端 95 项、核心 23 项、客户端 15 项、
一致性 7 项，合计 140/140，另交叉复测 27/27，均通过（0 失败）。真实 DSH
Desktop 宿主实测尚未做（见限制 2、3、6）。

## What to do next

1. 在 DSH Desktop 里安装本包（`install_local_workbench`），重启 Harness，
   在 Workbenches 切换区打开工作台，确认 6 个页面正常显示（数据从空开始）。
2. 配对浏览器扩展（或先手动扫码登录），验证绑定账号信息与笔记能拉取、
   笔记库出现已拉笔记镜像、封面能显示。
3. 在真实宿主上验证 `ctx.llm` 生成路径、生图通道与 `fetch.register` 注册形态，
   再决定是否把生成与拉取标为已跑通。
