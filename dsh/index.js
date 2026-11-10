// DSH 工作台插件入口：小红书运营工作台服务端。
//
// 只写服务端，不碰 Muse 工作台本身，不写任何用户数据。
// 接口统一挂在 /api/xiaohongshu-ops/ 前缀下，requestBody 用 'buffered'，
// 处理函数解析 JSON body、返回 JSON Response。
// 错误文案全部用中文，不把英文错误码直接返回给前端。

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { createCore } from '../packages/core/index.mjs'
import { createNodeStorage, createClock, createLogger } from './adapters.mjs'

export const name = 'xiaohongshu-ops'
export const inject = ['connection']

export const Config = Schema.object({
  root: Schema.string().required(),
})

const PREFIX = '/api/xiaohongshu-ops'
const XHS_LOGIN_URL = 'https://www.xiaohongshu.com/login'
const X_LOGIN_URL = 'https://www.x.com/i/flow/login'

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function clampStr(value, max, fallback = '') {
  if (value == null) return fallback
  return String(value).slice(0, max)
}

function intOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function intOrDefault(value, fallback = 0) {
  const n = intOrNull(value)
  return n == null ? fallback : n
}

// 用户粘贴的主页链接归一化（Muse actions.ts normalizeHomepageUrl 原样移植）：
// 去空格、缺 scheme 时补 https、只接受小红书域名，否则返回 null。
function normalizeHomepageUrl(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com') && host !== 'xhslink.com') {
    return null
  }
  return u.toString()
}

// ---- 时间换算：库里一律毫秒时间戳，出接口转 ISO 字符串 / YYYY-MM-DD ----
// （与 Muse gateToShape / fetchedNoteShape / noteShape 一致。）
function toIso(ms) {
  if (ms == null) return null
  if (typeof ms === 'number') {
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof ms === 'string') {
    const parsed = Date.parse(ms)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  return null
}
function fmtDateKey(ms) {
  if (ms == null) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const LOGIN_GATE_MESSAGE =
  '尚未获取已登录账号信息，不会获取笔记。请先点「获取已登录账号信息」——它会唤起 Muse 的浏览器直接读取当前已登录的小红书账号（未登录时会先让你扫码登录），获取成功后再获取真实笔记。'
const MONITOR_LOGIN_GATE_MESSAGE =
  '监测获取需要借用绑定账号的登录态：目前还没有已登录的绑定账号。请先去「账号管理」页扫码登录，登录成功后再回来获取这个监测账号的数据。'

// ---- 行映射：snake_case 存储行 -> camelCase 接口行 ----
function accountRow(row, fetchedCount = 0) {
  if (!row) return null
  return {
    id: row.id,
    nickname: row.nickname,
    xhsId: row.xhs_id,
    homepage: row.homepage,
    // 头像：真实头像原图 URL（avatar_source_url）；未读到为 null，
    // 客户端显示昵称首字占位（与 Muse resolveAvatarUrl 的无 blob 分支一致；
    // DSH 暂不提供头像 blob 下载路由，见回报 caveats）。
    avatarUrl: row.avatar_source_url || null,
    avatarSourceUrl: row.avatar_source_url || '',
    followersCount: row.followers_count,
    followingCount: row.following_count,
    likesCollectsCount: row.likes_collects_count,
    note: row.note,
    monitored: Boolean(row.monitored),
    loginStatus: row.login_status,
    loginVerifiedAt: toIso(row.login_verified_at),
    loginMessage: row.login_message,
    fetchStatus: row.fetch_status,
    fetchMessage: row.fetch_message,
    fetchedCount,
    fetchedAt: toIso(row.fetched_at),
    infoFetchStatus: row.info_fetch_status,
    infoFetchMessage: row.info_fetch_message || row.login_message,
    imageFetchStatus: row.image_fetch_status,
    imageFetchMessage: row.image_fetch_message,
    detailFetchStatus: row.detail_fetch_status,
    detailFetchMessage: row.detail_fetch_message,
    detailFetchTotal: row.detail_fetch_total,
    detailFetchDone: row.detail_fetch_done,
    createdAt: toIso(row.created_at),
  }
}

function fetchedNoteRow(row) {
  if (!row) return null
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    url: row.url,
    excerpt: row.excerpt,
    likes: row.likes,
    collects: row.collects,
    comments: row.comments,
    shares: row.shares,
    publishedLabel: row.published_label,
    publishedAt: fmtDateKey(row.published_at),
    images: parseJsonArray(row.images_json),
    fetchedAt: toIso(row.fetched_at),
  }
}

function assetRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    relativePath: row.relative_path,
    folderLabel: row.folder_label,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    blobKey: row.blob_key,
    contentUrl: `${PREFIX}/assets/${row.id}/content`,
    createdAt: toIso(row.created_at),
  }
}

function noteRow(row) {
  if (!row) return null
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    body: row.body,
    tags: parseJsonArray(row.tags_json),
    topic: row.topic,
    status: row.status,
    imageIds: parseJsonArray(row.image_ids_json),
    imageCaptions: parseJsonArray(row.image_captions_json),
    fetchedImages: parseJsonArray(row.fetched_images_json),
    source: row.source,
    sourceUrl: row.source_url,
    publishedAt: toIso(row.published_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function snapshotRow(row) {
  if (!row) return null
  return {
    id: row.id,
    noteId: row.note_id,
    likes: row.likes,
    collects: row.collects,
    shares: row.shares,
    comments: row.comments,
    capturedAt: toIso(row.captured_at),
  }
}

function monitoredAccountRow(row, fetchedCount = 0) {
  if (!row) return null
  return {
    id: row.id,
    nickname: row.nickname,
    xhsId: row.xhs_id,
    homepage: row.homepage,
    avatarUrl: row.avatar_source_url || null,
    avatarSourceUrl: row.avatar_source_url || '',
    followersCount: row.followers_count,
    followingCount: row.following_count,
    likesCollectsCount: row.likes_collects_count,
    note: row.note,
    fetchStatus: row.fetch_status,
    fetchMessage: row.fetch_message,
    fetchedCount,
    fetchedAt: toIso(row.fetched_at),
    createdAt: toIso(row.created_at),
  }
}

function monitoredNoteRow(row) {
  if (!row) return null
  return {
    id: row.id,
    monitoredAccountId: row.monitored_account_id,
    title: row.title,
    url: row.url,
    excerpt: row.excerpt,
    likes: row.likes,
    collects: row.collects,
    comments: row.comments,
    shares: row.shares,
    publishedLabel: row.published_label,
    images: parseJsonArray(row.images_json),
    fetchedAt: toIso(row.fetched_at),
  }
}

function monitoredSnapshotRow(row) {
  if (!row) return null
  return {
    id: row.id,
    monitoredNoteId: row.monitored_note_id,
    likes: row.likes,
    collects: row.collects,
    shares: row.shares,
    comments: row.comments,
    capturedAt: toIso(row.captured_at),
  }
}

function competitorNotificationRow(row) {
  if (!row) return null
  return {
    id: row.id,
    monitoredAccountId: row.monitored_account_id,
    monitoredNoteId: row.monitored_note_id ?? null,
    type: row.type,
    title: row.title,
    body: row.body,
    noteTitle: row.note_title,
    noteUrl: row.note_url,
    likes: row.likes ?? null,
    isRead: row.is_read === 1,
    createdAt: toIso(row.created_at),
  }
}

function leadNotificationRow(row) {
  if (!row) return null
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    senderName: row.sender_name,
    preview: row.preview,
    noteTitle: row.note_title,
    noteUrl: row.note_url,
    comments: row.comments ?? null,
    commentDelta: row.comment_delta ?? null,
    isRead: row.is_read === 1,
    createdAt: toIso(row.created_at),
  }
}

function leadDmConversationRow(row) {
  if (!row) return null
  return {
    id: row.id,
    senderName: row.sender_name,
    preview: row.preview,
    unreadCount: row.unread_count,
    timeLabel: row.time_label,
    fetchedAt: toIso(row.fetched_at),
  }
}

function hotspotItemRow(row) {
  if (!row) return null
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    summary: row.summary,
    url: row.url,
    keyword: row.keyword,
    author: row.author,
    fetchedAt: toIso(row.fetched_at),
  }
}

function sharedSessionRequestRow(row) {
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.account_id ?? null,
    monitoredAccountId: row.monitored_account_id ?? null,
    noteId: row.note_id ?? null,
    payload: row.payload,
    status: row.status,
    message: row.message,
    resultMessage: row.result_message,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    fulfilledAt: toIso(row.fulfilled_at),
  }
}

// 宿主可能以 Request、{ body }、{ request } 或直接以 body 对象调用处理函数，
// 这里都兼容解析。
async function parseBody(input) {
  const req = input?.request ?? input
  if (!req) return {}
  if (typeof req.json === 'function') {
    try {
      return (await req.json()) ?? {}
    } catch {
      return {}
    }
  }
  if (typeof req.text === 'function') {
    const text = await req.text()
    if (!text) return {}
    try {
      return JSON.parse(text) ?? {}
    } catch {
      return {}
    }
  }
  const raw = req.body ?? req
  if (raw == null) return {}
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    const text = Buffer.from(raw).toString('utf8')
    if (!text.trim()) return {}
    try {
      return JSON.parse(text) ?? {}
    } catch {
      return {}
    }
  }
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try {
      return JSON.parse(raw) ?? {}
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object') return raw
  return {}
}

export function apply(ctx, config) {
  const root = config.root
  // 依赖注入：core 只认注入的 storage / llm / bridge / clock / logger，
  // 宿主实现全部在 ./adapters.mjs；浏览器桥接在 v1 未配对（传 null）。
  const core = createCore({
    storage: createNodeStorage(root),
    llm: ctx.llm ?? null,
    bridge: null,
    clock: createClock(),
    logger: createLogger(),
  })
  const store = core.store
  const bridge = core.bridge
  const resolveLoginGate = core.resolveLoginGate
  const generateNote = core.generateNote
  const generateImage = core.generateImage
  const testImageGenApi = core.testImageGenApi
  const getImageGenSettings = core.getImageGenSettings
  const sharedChannelActive = core.sharedChannelActive
  const sharedRouteMessage = core.sharedRouteMessage
  const dueHandshake = core.dueHandshake
  const dueHotspotSearch = core.dueHotspotSearch
  const nowIso = core.nowIso
  const nowMs = core.nowMs
  const HANDSHAKE_INTERVAL_MS = core.HANDSHAKE_INTERVAL_MS
  const HOTSPOT_TICK_INTERVAL_MS = core.HOTSPOT_TICK_INTERVAL_MS

  if (!ctx.connection?.fetch?.register) {
    throw new Error(
      '小红书运营工作台启动失败：宿主未提供 connection.fetch.register，无法注册服务端接口。',
    )
  }

  const register = ctx.connection.fetch.register.bind(ctx.connection.fetch)
  // 注册形态以 beianbai 跨平台账号看板实测为准：{ path, methods: [method], requestBody: 'buffered', fetch: fn }
  // （工作台标准正文只规定了 /api/<id>/ 前缀，未规定此 API 的具体签名；若目标 Desktop 版本签名不同，只改这一处。）
  function registerRoute(method, path, handler) {
    register({ path, methods: [method], requestBody: 'buffered', fetch: handler })
  }

  // ---- 登录门禁写回：唯一写 gate=valid / gate=expired 的地方 ----
  // 门禁只存在门禁账号行的 gate_* 列上（store.writeGate），
  // login_session 表已删除，这里不再读写它。
  // 唯一写 gate=valid 的地方：成功读账号信息、结论性 logged_in 的
  // 握手回写、共用会话 conclusive logged_in 报告；
  // 唯一写 gate=expired 的地方：结论性 logged_out 的握手回写
  // （且共用会话有更新的登录确认时不写，见 applyConclusiveLoggedOut）。
  function applyConclusiveLoggedIn(info = {}) {
    const now = nowMs()
    let account = null
    if (info.xhsId) account = store.getAccountByXhsId(info.xhsId)
    if (!account && info.nickname) {
      account = store.listAccounts().find((a) => a.nickname === info.nickname) ?? null
    }
    if (account) {
      const patch = {
        login_status: 'verified',
        login_verified_at: now,
        login_message: '',
        info_fetch_status: 'done',
        info_fetch_message: '',
        info_fetch_task_id: '',
        info_fetch_started_at: null,
      }
      if (info.nickname) patch.nickname = info.nickname
      if (info.xhsId) patch.xhs_id = info.xhsId
      if (info.homepage) patch.homepage = info.homepage
      if (info.followingCount != null) patch.following_count = info.followingCount
      if (info.followersCount != null) patch.followers_count = info.followersCount
      if (info.likesCollectsCount != null) patch.likes_collects_count = info.likesCollectsCount
      if (info.avatarUrl) patch.avatar_source_url = info.avatarUrl
      store.updateAccount(account.id, patch)
      store.writeGate(account.id, {
        gate_state: 'valid',
        gate_browser_state: 'logged_in',
        gate_handshake_status: 'valid',
        gate_handshake_message: '',
        gate_handshake_task_id: '',
        gate_last_handshake_at: now,
        gate_last_verified_at: now,
        gate_qr_auto_opened_at: null,
      })
    }
    return account
  }

  // 结论性 logged_out 的握手回写。返回 { qrAutoOpened, sharedProtects }：
  // - 共用会话保护（Muse applyHandshakeResult）：共用会话持有 24 小时内
  //   且不 older 于本次握手尝试的 logged_in 确认时，只记录任务浏览器
  //   的事实（browserState/handshakeStatus/message），不写 gate=expired、
  //   不改记录态、不自动开扫码页。
  // - QR 只自动唤起一次（Muse 口径）：仅 valid -> expired 跃迁、且
  //   qrAutoOpenedAt 不晚于上次确认（即本轮过期后尚未自动开过）时才开；
  //   本轮过期后再次握手不再重复弹；重新登录确认后下次过期可再弹一次。
  function applyConclusiveLoggedOut() {
    const now = nowMs()
    const gateBefore = resolveLoginGate()
    const gateAccount = store.getGateAccount()
    const targetId = gateAccount?.id ?? gateBefore.accountId
    if (targetId == null) return { qrAutoOpened: false, sharedProtects: false }
    const sharedAt = gateAccount?.gate_shared_at ?? null
    const sharedProtects =
      gateAccount?.gate_shared_state === 'logged_in' &&
      sharedAt != null &&
      now - sharedAt <= 24 * 3600 * 1000 &&
      (gateBefore.lastHandshakeAt == null ||
        sharedAt >= Date.parse(gateBefore.lastHandshakeAt))
    if (sharedProtects) {
      store.writeGate(targetId, {
        gate_last_handshake_at: now,
        gate_handshake_status: 'expired',
        gate_handshake_task_id: '',
        gate_browser_state: 'logged_out',
        gate_handshake_message:
          '握手确认：工作台自己的任务浏览器未登录，但共用会话（Muse 聊天里你能看到的浏览器）仍确认登录着这个账号——登录态以共用会话为准，保持已登录；任务浏览器未登录只影响它自己的备用通道，读取和发布走共用会话。',
      })
      return { qrAutoOpened: false, sharedProtects: true }
    }
    const wasValid = gateBefore.isLoggedIn || gateBefore.recordedStatus === 'verified'
    const lastConfirmedAt = gateBefore.lastConfirmedAt
      ? Date.parse(gateBefore.lastConfirmedAt)
      : null
    const qrAutoOpenedAt = gateAccount?.gate_qr_auto_opened_at ?? null
    const alreadyOpenedForEpisode =
      qrAutoOpenedAt != null &&
      lastConfirmedAt != null &&
      qrAutoOpenedAt >= lastConfirmedAt
    const qrAutoOpened = wasValid && !alreadyOpenedForEpisode
    const patch = {
      gate_browser_state: 'logged_out',
      gate_handshake_status: 'expired',
      gate_handshake_message: '浏览器确认已登出。',
      gate_handshake_task_id: '',
      gate_last_handshake_at: now,
      gate_state: 'expired',
    }
    if (qrAutoOpened) {
      patch.gate_qr_auto_opened_at = now
      patch.gate_qr_last_opened_at = now
    }
    store.writeGate(targetId, patch)
    // 记录态只由 conclusive 登出改变：loginStatus -> failed
    //（信息读取失败永不擦除记录态，见 saveLoggedInAccountInfo）。
    const primary = gateBefore.accountId ? store.getAccount(gateBefore.accountId) : null
    if (primary) {
      store.updateAccount(primary.id, {
        login_status: 'failed',
        login_task_id: '',
        login_message: '登录已失效：每 60 秒握手确认工作台浏览器已未登录小红书，请重新扫码登录。',
      })
    }
    return { qrAutoOpened, sharedProtects: false }
  }

  // 信息读取失败只动 info 管线自身状态，永不擦除已记录的登录确认
  //（Muse writeInfoReadFailure，校准规则 5）。
  function writeInfoReadFailure(account, text) {
    if (!account) return
    store.updateAccount(account.id, {
      ...(account.login_status === 'verified' ? {} : { login_status: 'failed' }),
      login_task_id: '',
      login_message: text,
      info_fetch_status: 'failed',
      info_fetch_task_id: '',
      info_fetch_message: text,
      info_fetch_started_at: null,
    })
  }

  // 握手 / info-fetch 的 10 分钟硬超时自清（读时派生 + 持久化）：
  // 超时的 checking 握手记 unknown、超时的 fetching 信息读取记 failed，
  // 结论都是“任务无回写”，不改记录态、不开扫码页、不怪用户。
  // DSH 无 ctx.agent.status，任务状态无法再查——超时分支就是全部。
  function syncHandshakeTimeout() {
    const gateAccount = store.getGateAccount()
    if (!gateAccount) return
    const lastHandshakeAt = gateAccount.gate_last_handshake_at
    if (
      gateAccount.gate_handshake_status === 'checking' &&
      lastHandshakeAt != null &&
      nowMs() - lastHandshakeAt > 10 * 60 * 1000
    ) {
      store.writeGate(gateAccount.id, {
        gate_handshake_status: 'unknown',
        gate_handshake_task_id: '',
        gate_handshake_message:
          '后台登录确认超时：这次握手任务超过 10 分钟没有回写结果（任务无回写），未能确认登录态。这不等于掉登录——工作台记录的登录态保持不变，下一次握手会重新确认。',
      })
    }
  }
  function syncInfoFetchTimeout() {
    for (const account of store.listAccounts()) {
      if (
        (account.info_fetch_status === 'fetching' || account.login_status === 'verifying') &&
        account.info_fetch_started_at != null &&
        nowMs() - account.info_fetch_started_at > 10 * 60 * 1000
      ) {
        writeInfoReadFailure(
          account,
          '这次获取超过 10 分钟没有回写结果（任务无回写），已按超时结束这次等待。工作台记录的登录态保持不变；想登录时点「打开浏览器扫码登录」，会立刻打开一个新的扫码登录。',
        )
      }
    }
  }

  // ---- 握手 tick：每 60 秒一次，防重叠 ----
  // 先同步上一握手任务的超时（10 分钟硬超时自清），再在无检查/
  // 无信息读取在途时派发一只读握手。无桥时记 handshake_status='unknown'、
  // 不改门禁；inconclusive 握手绝不翻门禁；conclusive 登出走
  // applyConclusiveLoggedOut（含共用会话保护与 QR 只弹一次）。
  let tickRunning = false
  async function handshakeTick() {
    if (tickRunning) {
      return {
        ok: true,
        skipped: true,
        gate: resolveLoginGate(),
        message: '上一次握手还在进行，本次跳过。',
      }
    }
    syncHandshakeTimeout()
    syncInfoFetchTimeout()
    const gate = resolveLoginGate()
    const gateAccount = store.getGateAccount()
    if (!dueHandshake(gateAccount?.gate_last_handshake_at)) {
      return {
        ok: true,
        skipped: true,
        gate: resolveLoginGate(),
        message: '距离上次握手不足 60 秒，本次跳过。',
      }
    }
    if (gate.checkInFlight) {
      return {
        ok: true,
        skipped: true,
        gate: resolveLoginGate(),
        message: '已有登录确认在进行中（握手或信息读取），本次握手跳过。',
      }
    }
    if (!gateAccount) {
      return {
        ok: true,
        skipped: true,
        gate: resolveLoginGate(),
        message: '还没有绑定账号，无法握手校验。',
      }
    }
    tickRunning = true
    try {
      const bridgeStatus = bridge.getBridgeStatus()
      if (!bridgeStatus.paired) {
        // 无桥接：记 inconclusive，绝不误报掉登录，绝不改变门禁。
        store.writeGate(gateAccount.id, {
          gate_handshake_status: 'unknown',
          gate_handshake_message: '浏览器扩展未配对，无法确认登录状态；登录门禁未改变。',
          gate_last_handshake_at: nowMs(),
        })
        return {
          ok: true,
          conclusive: false,
          gate: resolveLoginGate(),
          message: '浏览器扩展未配对，握手结果无法确定，登录状态未改变。',
        }
      }
      const result = await bridge.run({ kind: 'checkLogin' })
      if (!result || result.conclusive !== true) {
        store.writeGate(gateAccount.id, {
          gate_handshake_status: 'unknown',
          gate_handshake_message: '握手结果无法确定，未改变登录门禁。',
          gate_last_handshake_at: nowMs(),
        })
        return {
          ok: true,
          conclusive: false,
          gate: resolveLoginGate(),
          message: '握手结果无法确定，登录状态未改变。',
        }
      }
      if (result.loggedIn) {
        applyConclusiveLoggedIn(result)
        return {
          ok: true,
          conclusive: true,
          gate: resolveLoginGate(),
          message: '握手确认已登录。',
        }
      }
      const { qrAutoOpened, sharedProtects } = applyConclusiveLoggedOut()
      return {
        ok: true,
        conclusive: true,
        gate: resolveLoginGate(),
        message: sharedProtects
          ? '握手确认任务浏览器已登出，但共用会话仍登录，登录态保持已登录。'
          : qrAutoOpened
            ? '握手确认已登出，已自动唤起一次扫码登录。'
            : '握手确认已登出，请重新扫码登录。',
      }
    } finally {
      tickRunning = false
    }
  }

  // ---- 热点 tick：每 15 分钟一次，防重叠 ----
  // 先清理超 7 天资讯，再启动到期的检索（小红书按用户间隔、
  // X 固定 12 小时）。无桥/未登录时到期检索按 §6.1 返回明确原因、
  // 不派任务、不谎称已检索；共用会话通道下登记共用会话请求。
  let hotspotTickRunning = false
  async function hotspotTick() {
    if (hotspotTickRunning) return { ok: true, skipped: true, message: '上一次热点 tick 还在进行，本次跳过。' }
    hotspotTickRunning = true
    try {
      const cleaned = store.cleanupHotspotItems()
      const config = store.getHotspotConfig()
      if (!config.enabled) {
        return { ok: true, startedXhs: false, startedX: false, cleaned, message: '自动检索已关闭，本次只做了 7 天清理。' }
      }
      if (config.keywords.length === 0) {
        return { ok: true, startedXhs: false, startedX: false, cleaned, message: '还没有设置检索关键词，自动检索跳过。' }
      }
      const state = store.getHotspotState()
      const { xhsDue, xDue } = dueHotspotSearch(state, config, nowMs())
      let startedXhs = false
      let startedX = false
      if (xhsDue) startedXhs = startHotspotXhsSearch()
      if (xDue) startedX = startHotspotXSearch()
      return {
        ok: true,
        startedXhs,
        startedX,
        cleaned,
        message: `到期检查完成：小红书${xhsDue ? (startedXhs ? '已开始检索' : '到时但未能开始（见热点页状态）') : '未到期'}；X${xDue ? (startedX ? '已开始检索' : '到时但未能开始（见热点页状态）') : '未到期'}；清理过期资讯 ${cleaned} 条。`,
      }
    } finally {
      hotspotTickRunning = false
    }
  }

  const timer = core.clock.setInterval(() => {
    handshakeTick().catch(() => {
      // 握手失败不抛到宿主，只记 inconclusive；下次定时再试。
    })
  }, HANDSHAKE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  const hotspotTimer = core.clock.setInterval(() => {
    hotspotTick().catch(() => {
      // 热点 tick 失败不抛到宿主；下次定时再试。
    })
  }, HOTSPOT_TICK_INTERVAL_MS)
  if (typeof hotspotTimer.unref === 'function') hotspotTimer.unref()

  const dispose = () => {
    core.clock.clearInterval(timer)
    core.clock.clearInterval(hotspotTimer)
    try {
      store.close()
    } catch {
      // 关闭失败不抛
    }
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose)
    } catch {
      // effect 不可用时由宿主生命周期管理
    }
  } else if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', dispose)
    } catch {
      // 忽略
    }
  }

  function notStarted(message) {
    return { ok: true, started: false, message }
  }

  function bridgeNotPairedMessage(what) {
    return `浏览器扩展未配对，无法${what}；请先配对浏览器扩展。`
  }

  /** save* 类回写统一过门禁；门禁不过整批丢弃并写明原因。 */
  function gateBlockedResult() {
    const gate = resolveLoginGate()
    if (gate.canFetch) return null
    return {
      ok: true,
      success: false,
      discarded: true,
      message: `登录门禁未通过（${gate.message}），本次结果已丢弃，未写入。`,
      gate,
    }
  }

  // 特定绑定账号的门禁：只有门禁账号本人可拉取/回写（Muse gateAllowsAccount）。
  function gateAllowsAccount(accountId) {
    const gate = resolveLoginGate()
    return gate.canFetch && gate.accountId === accountId
  }

  function humanizeTaskFailure(raw) {
    if (!raw) return ''
    if (String(raw).includes('expected_return_action_missing')) {
      return '读取任务结束了，但没有把结果回写到工作台（这是上一个读取任务没有接回结果，不是登录掉线）'
    }
    return String(raw)
  }

  // 登录依赖型工作的启动口径（Muse 各 start* 函数的 DSH 对等）：
  // 先过门禁；共用会话通道激活时登记共用会话请求（started=false，
  // 但工作已登记、不丢）；否则桥未配对时返回明确中文原因。
  // 返回 { started, message }；调用方按需再写本管线状态。
  function startSharedOrBridge(kind, target, label) {
    const gate = resolveLoginGate()
    // account_info 是登录入口本身（扫码/读账号信息），未登录时也可登记，
    // 不能被门禁挡住；其余种类一律先过门禁。
    if (kind !== 'account_info' && !gate.canFetch) {
      return { started: false, message: `登录门禁未通过：${gate.message}` }
    }
    if (sharedChannelActive(gate)) {
      const msg = sharedRouteMessage(label)
      store.upsertSharedRequest(kind, { ...target, message: msg })
      return { started: false, shared: true, message: msg }
    }
    if (!bridge.paired) {
      return { started: false, message: bridgeNotPairedMessage(label) }
    }
    return { started: false, message: '浏览器桥已配对，但 DSH 宿主尚未实现该浏览器任务的派发，请等待扩展交付。' }
  }

  // ---- 热点检索启动（小红书 / X） ----
  function startHotspotXhsSearch() {
    const state = store.getHotspotState()
    if (state.xhs_status === 'fetching') return false
    const config = store.getHotspotConfig()
    const now = nowMs()
    if (config.keywords.length === 0) {
      store.updateHotspotState({
        xhs_status: 'failed',
        xhs_task_id: '',
        xhs_last_attempt_at: now,
        xhs_message: '还没有设置检索关键词：先在热点资讯页填好关键词并保存，再开始检索。',
      })
      return false
    }
    const gate = resolveLoginGate()
    if (!gate.canFetch) {
      store.updateHotspotState({
        xhs_status: 'failed',
        xhs_task_id: '',
        xhs_last_attempt_at: now,
        xhs_message:
          gate.verdict === 'unknown'
            ? `小红书检索暂时进行不了：${gate.message}`
            : `小红书检索需要先登录：${gate.message}请先去「账号管理」扫码登录小红书，登录成功后再点立即检索。`,
      })
      return false
    }
    if (sharedChannelActive(gate)) {
      const msg = sharedRouteMessage('按关键词检索小红书热点')
      store.upsertSharedRequest('hotspot_xhs', { accountId: gate.accountId, message: msg })
      store.updateHotspotState({
        xhs_status: 'idle',
        xhs_task_id: '',
        xhs_last_attempt_at: now,
        xhs_message: msg,
      })
      return false
    }
    return false // 桥未配对：下行由 startSharedOrBridge 的文案兜底
  }
  function startHotspotXhsSearchWithMessage() {
    const started = startHotspotXhsSearch()
    if (started) return { started: true, message: '小红书检索已开始。' }
    const state = store.getHotspotState()
    if (state.xhs_status === 'fetching') return { started: false, message: '小红书检索已经在进行了。' }
    if (state.xhs_message && state.xhs_message.includes('共用登录会话')) {
      return { started: false, message: state.xhs_message }
    }
    if (state.xhs_message && (state.xhs_message.includes('关键词') || state.xhs_message.includes('登录'))) {
      return { started: false, message: state.xhs_message }
    }
    return { started: false, message: bridgeNotPairedMessage('检索小红书热点') }
  }
  function startHotspotXSearch() {
    const state = store.getHotspotState()
    if (state.x_status === 'fetching') return false
    const config = store.getHotspotConfig()
    const now = nowMs()
    if (config.keywords.length === 0) {
      store.updateHotspotState({
        x_status: 'failed',
        x_task_id: '',
        x_last_attempt_at: now,
        x_message: '还没有设置检索关键词：先在热点资讯页填好关键词并保存，再开始检索。',
      })
      return false
    }
    return false // X 检索同样走浏览器桥：无桥时只返回明确原因（见调用方）。
  }
  function startXLoginTask() {
    const state = store.getHotspotState()
    if (state.x_login_status === 'checking') return false
    store.updateHotspotState({
      x_login_status: 'checking',
      x_login_task_id: '',
      x_login_message: '已唤起浏览器打开 X 登录页：请在打开的浏览器里用你自己的邮箱和密码登录 X（密码只输进 X 的登录页，工作台不会保存），登录完成这里会自动更新。',
    })
    return false // 无桥：登录页入口由调用方返回 xLoginUrl，见 startxlogin。
  }
  function startXLoginCheckTask() {
    const state = store.getHotspotState()
    if (state.x_login_status === 'checking') return false
    store.updateHotspotState({
      x_login_status: 'checking',
      x_login_task_id: '',
      x_login_check_method: 'random_browse',
      x_login_browsed_json: '[]',
      x_login_message: '正在用随机浏览检查 X 登录态：在浏览器里打开 X 首页、搜索页等几个页面，看是否还是登录状态…',
    })
    return false // 无桥：只返回明确原因，见调用方。
  }

  // ---- 留资私信检查启动 ----
  function startLeadDmCheckTask() {
    const state = store.getLeadState()
    if (state.dm_status === 'fetching') return false
    const now = nowMs()
    const gate = resolveLoginGate()
    if (!gate.canFetch) {
      store.updateLeadState({
        dm_status: 'failed',
        dm_task_id: '',
        dm_last_attempt_at: now,
        dm_message:
          gate.verdict === 'unknown'
            ? `私信检查暂时进行不了：${gate.message}`
            : `私信检查需要先登录：${gate.message}请先去「账号管理」扫码登录小红书，登录成功后再点「立即检查私信」。`,
      })
      return false
    }
    if (sharedChannelActive(gate)) {
      const msg = sharedRouteMessage('检查主账号的私信列表')
      store.upsertSharedRequest('lead_dm', { accountId: gate.accountId, message: msg })
      store.updateLeadState({
        dm_status: 'idle',
        dm_task_id: '',
        dm_last_attempt_at: now,
        dm_message: msg,
      })
      return false
    }
    return false // 桥未配对：调用方返回明确原因。
  }

  // ---- 热点 feed / 留资监控 / 首次使用状态（读侧聚合） ----
  function hotspotSourceShape(state, source, config) {
    const isXhs = source === 'xiaohongshu'
    const status = isXhs ? state.xhs_status : state.x_status
    const message = isXhs ? state.xhs_message : state.x_message
    const lastFetchedAt = isXhs ? state.xhs_last_fetched_at : state.x_last_fetched_at
    const lastAttemptAt = isXhs ? state.xhs_last_attempt_at : state.x_last_attempt_at
    const intervalMs = isXhs
      ? config.intervalHours * 3600 * 1000
      : 12 * 3600 * 1000
    let nextDueAt = null
    if (config.enabled && config.keywords.length > 0 && status !== 'fetching') {
      nextDueAt = lastAttemptAt != null ? lastAttemptAt + intervalMs : nowMs()
      if (nextDueAt < nowMs()) nextDueAt = nowMs()
    }
    return {
      status,
      message: humanizeTaskFailure(message),
      lastFetchedAt: toIso(lastFetchedAt),
      lastAttemptAt: toIso(lastAttemptAt),
      nextDueAt: toIso(nextDueAt),
    }
  }
  function loadHotspotFeed() {
    store.cleanupHotspotItems()
    const config = store.getHotspotConfig()
    const state = store.getHotspotState()
    return {
      config,
      xhs: hotspotSourceShape(state, 'xiaohongshu', config),
      x: hotspotSourceShape(state, 'x', config),
      xLogin: {
        status: state.x_login_status,
        message: humanizeTaskFailure(state.x_login_message),
        checkedAt: toIso(state.x_login_checked_at),
        checkMethod: state.x_login_check_method,
        browsedPages: parseJsonArray(state.x_login_browsed_json),
      },
      items: store.listHotspotItems().map(hotspotItemRow),
    }
  }
  function loadLeadMonitor() {
    const state = store.getLeadState()
    const { notifications, unreadCount } = store.listLeadNotifications(50)
    return {
      dm: {
        status: state.dm_status,
        message: humanizeTaskFailure(state.dm_message),
        lastFetchedAt: toIso(state.dm_last_fetched_at),
        lastAttemptAt: toIso(state.dm_last_attempt_at),
        unreadTotal: state.dm_unread_total ?? null,
        conversationCount: state.dm_conversation_count ?? null,
      },
      conversations: store.listLeadConversations().map(leadDmConversationRow),
      notifications: notifications.map(leadNotificationRow),
      unreadCount,
    }
  }
  function loadOnboardingState() {
    const gate = resolveLoginGate()
    const xState = store.getHotspotState()
    const accountRows = store.listAccounts()
    let promptedAt = store.getSettings().first_use_login_prompted_at ?? null
    if (promptedAt == null && accountRows.length > 0) {
      // 已有账号的旧安装：懒打戳，永不再自动弹首次登录。
      promptedAt = nowMs()
      store.updateSettings({ first_use_login_prompted_at: promptedAt })
    }
    const xhsNeeded = !gate.isLoggedIn
    const xNeeded = xState.x_login_status !== 'logged_in' && xState.x_login_status !== 'checking'
    return {
      isFirstUse: promptedAt == null && accountRows.length === 0,
      promptedAt: toIso(promptedAt),
      xhsNeeded,
      xhsState: gate.state,
      xNeeded,
      xLoginStatus: xState.x_login_status,
      xLoginMessage: humanizeTaskFailure(xState.x_login_message),
    }
  }

  // 登录账号信息回写的共用逻辑（Muse applyLoggedInInfo 的 DSH 对等，
  // 不含头像 blob 下载：头像只存原图 URL）：
  // - success 且有昵称：按 xhsId 归属写到对应记录（占位/重复记录合并），
  //   写 verified + gate=valid，并 fulfill account_info 共用会话请求；
  // - success 但无昵称 / 失败：只动 info 管线状态，永不擦除已记录的
  //   登录确认；失败原因不是扫码超时时，DSH 无浏览器可自动重试，
  //   如实写失败原因（不谎称已重试）。
  function applyLoggedInInfo(args) {
    const source = store.getAccount(args.accountId)
    if (!source) return { ok: false, message: '账号不存在。' }
    const now = nowMs()
    const nickname = clampStr(args.nickname ?? '', 60).trim()
    const xhsId = clampStr(args.xhsId ?? '', 60).trim()
    const homepage = clampStr(args.homepage ?? '', 1000).trim()
    const avatarUrl = clampStr(args.avatarUrl ?? '', 2000).trim()
    const message = clampStr(args.message ?? '', 500).trim()
    if (args.success && nickname) {
      let targetId = args.accountId
      if (xhsId) {
        const dup = store
          .listAccounts()
          .find((r) => r.id !== args.accountId && r.xhs_id !== '' && r.xhs_id === xhsId)
        if (dup) {
          targetId = dup.id
          if (source.nickname === '新账号 · 等待扫码登录') {
            for (const n of store.listNotes()) {
              if (n.account_id === args.accountId) store.updateNote(n.id, { account_id: targetId })
            }
            store.reassignFetchedNotes(args.accountId, targetId)
            store.deleteAccount(args.accountId)
          } else {
            store.updateAccount(args.accountId, {
              login_status: 'unverified',
              login_task_id: '',
              login_verified_at: null,
              info_fetch_status: 'idle',
              info_fetch_task_id: '',
              info_fetch_started_at: null,
              info_fetch_message: `这次读到的已登录账号是「${nickname}」，已更新到它自己的绑定记录下，这张卡片没有改动。`,
              login_message: `这次读到的已登录账号是「${nickname}」，已更新到它自己的绑定记录下，这张卡片没有改动。`,
            })
          }
        }
      }
      const patch = {
        nickname,
        ...(xhsId ? { xhs_id: xhsId } : {}),
        ...(homepage ? { homepage } : {}),
        ...(args.followingCount !== undefined ? { following_count: intOrNull(args.followingCount) } : {}),
        ...(args.followersCount !== undefined ? { followers_count: intOrNull(args.followersCount) } : {}),
        ...(args.likesCollectsCount !== undefined
          ? { likes_collects_count: intOrNull(args.likesCollectsCount) }
          : {}),
        ...(avatarUrl ? { avatar_source_url: avatarUrl } : {}),
        login_status: 'verified',
        login_task_id: '',
        login_message: message || `已获取已登录账号「${nickname}」的账号信息。`,
        login_verified_at: now,
        info_fetch_status: 'done',
        info_fetch_task_id: '',
        info_fetch_started_at: null,
        info_fetch_message: message || `已获取已登录账号「${nickname}」的账号信息。`,
      }
      store.updateAccount(targetId, patch)
      store.writeGate(targetId, {
        gate_state: 'valid',
        gate_last_verified_at: now,
        gate_last_handshake_at: now,
        gate_handshake_status: 'valid',
        gate_browser_state: 'logged_in',
        gate_handshake_message: '账号信息读取时确认工作台浏览器为已登录状态。',
        gate_qr_auto_opened_at: null,
      })
      store.fulfillSharedRequests('account_info', { accountId: targetId }, '已读取并回写已登录账号信息。')
      return { ok: true, accountId: targetId }
    }
    const reason =
      args.success && !nickname
        ? message || '这次没有读到已登录账号的昵称，未能获取账号信息。'
        : message || '未能获取已登录账号信息：小红书未登录，或页面读取失败。'
    writeInfoReadFailure(source, humanizeTaskFailure(reason))
    return { ok: false, message: reason }
  }

  // ================= 83 个动作（82 个 Muse 动作 + getstate 聚合端点） =================
  const actions = {
    // ---- 设置 ----
    getsettings() {
      const settings = store.getSettings()
      return {
        ok: true,
        settings: {
          dataDirLabel: settings.data_dir_label,
          updatedAt: toIso(settings.updated_at),
        },
      }
    },
    updatesettings(body) {
      const dataDirLabel = body.dataDirLabel ?? body.data_dir_label ?? ''
      if (typeof dataDirLabel !== 'string' || dataDirLabel.length > 300) {
        return { ok: false, message: '数据文件夹路径最多 300 字，请缩短后重试。' }
      }
      const settings = store.updateSettings({ data_dir_label: dataDirLabel })
      return {
        ok: true,
        settings: { dataDirLabel: settings.data_dir_label, updatedAt: toIso(settings.updated_at) },
        message: '设置已保存。',
      }
    },

    // ---- 绑定 / 主账号 ----
    listaccounts() {
      return {
        ok: true,
        accounts: store
          .listAccounts()
          .map((a) => accountRow(a, store.countFetchedNotes(a.id))),
      }
    },
    bindaccount() {
      return {
        ...notStarted('浏览器扩展未配对，无法自动开始绑定；请在浏览器中打开小红书登录页扫码登录。'),
        loginUrl: XHS_LOGIN_URL,
      }
    },
    startbindloggedinaccount() {
      return {
        ...notStarted('浏览器扩展未配对，无法开始绑定已登录账号；请先配对浏览器扩展。'),
        loginUrl: XHS_LOGIN_URL,
      }
    },
    startfetchloggedininfo(body) {
      const account = store.getAccount(body.accountId)
      if (!account) return { ok: false, message: '账号不存在。' }
      const res = startSharedOrBridge('account_info', { accountId: account.id }, '读取登录账号信息')
      if (res.shared) {
        return { ok: true, started: false, message: res.message }
      }
      return notStarted(res.message)
    },
    startverifylogin(body) {
      const account = store.getAccount(body.accountId)
      if (!account) return { ok: false, message: '账号不存在。' }
      const res = startSharedOrBridge('account_info', { accountId: account.id }, '验证登录状态')
      if (res.shared) {
        return { ok: true, started: false, message: res.message }
      }
      return notStarted(res.message)
    },
    startfetchaccountnotes(body) {
      const account = store.getAccount(body.accountId)
      if (!account) return { ok: false, message: '账号不存在。' }
      const gate = resolveLoginGate()
      if (!gateAllowsAccount(account.id)) {
        store.updateAccount(account.id, {
          fetch_status: 'idle',
          fetch_task_id: '',
          fetch_message: LOGIN_GATE_MESSAGE,
        })
        return notStarted(`登录门禁未通过：${gate.message}`)
      }
      const res = startSharedOrBridge('account_notes', { accountId: account.id }, '拉取这个账号的真实笔记')
      return notStarted(res.message)
    },
    startbackfillnoteimages(body) {
      let account = null
      if (body.accountId != null) {
        account = store.getAccount(body.accountId)
        if (!account) return { ok: false, message: '账号不存在。' }
      } else {
        const gate = resolveLoginGate()
        account = gate.accountId ? store.getAccount(gate.accountId) : store.listAccounts()[0]
        if (!account) return { ok: true, started: false }
      }
      if (!gateAllowsAccount(account.id)) {
        store.updateAccount(account.id, {
          image_fetch_status: 'idle',
          image_fetch_task_id: '',
          image_fetch_message: LOGIN_GATE_MESSAGE,
        })
        return notStarted(`登录门禁未通过：${resolveLoginGate().message}`)
      }
      const res = startSharedOrBridge('note_images', { accountId: account.id }, '补拉这个账号笔记的配图')
      return notStarted(res.message)
    },
    startbackfillnotedetails(body) {
      let account = null
      if (body.accountId != null) {
        account = store.getAccount(body.accountId)
        if (!account) return { ok: false, message: '账号不存在。' }
      } else {
        const gate = resolveLoginGate()
        account = gate.accountId ? store.getAccount(gate.accountId) : store.listAccounts()[0]
        if (!account) return { ok: true, started: false }
      }
      if (!gateAllowsAccount(account.id)) {
        store.updateAccount(account.id, {
          detail_fetch_status: 'idle',
          detail_fetch_task_id: '',
          detail_fetch_message: LOGIN_GATE_MESSAGE,
        })
        return { ok: true, started: false }
      }
      // 第一步先就地换算（不走浏览器）：已存相对标签按读取日换算成绝对日期。
      const { locallyDated, targets } = store.convertPublishedLabels(account.id)
      if (targets.length === 0) {
        store.updateAccount(account.id, {
          detail_fetch_status: 'done',
          detail_fetch_task_id: '',
          detail_fetch_message:
            locallyDated > 0
              ? `已把 ${locallyDated} 篇笔记的发布时间按拉取当天的日期换算成绝对日期；这个账号已获取笔记的发布日期和收藏/分享/评论数都齐了。`
              : '这个账号已获取笔记的发布日期和收藏/分享/评论数都已经读回来了，发布日历可以直接排。',
          detail_fetch_total: 0,
          detail_fetch_done: 0,
        })
        return { ok: true, started: false }
      }
      const res = startSharedOrBridge(
        'note_details',
        { accountId: account.id },
        '补齐这个账号笔记的发布日期和详情数据',
      )
      if (res.shared) {
        store.updateAccount(account.id, {
          detail_fetch_status: 'idle',
          detail_fetch_task_id: '',
          detail_fetch_message: res.message,
          detail_fetch_total: 0,
          detail_fetch_done: 0,
        })
      }
      return notStarted(res.message)
    },
    deleteaccount(body) {
      const account = store.getAccount(body.id)
      if (!account) return { ok: false, message: '账号不存在。' }
      store.deleteAccount(body.id)
      return { ok: true, message: '账号已删除。' }
    },
    updateaccount(body) {
      const account = store.getAccount(body.id)
      if (!account) return { ok: false, message: '账号不存在。' }
      const updated = store.updateAccount(body.id, {
        note: clampStr(body.note ?? '', 300),
      })
      return {
        ok: true,
        account: accountRow(updated, store.countFetchedNotes(body.id)),
        message: '账号备注已保存。',
      }
    },

    // ---- 登录门禁 / 握手 ----
    getlogingate() {
      return { ok: true, gate: resolveLoginGate() }
    },

    // ---- 聚合状态（客户端 loadAll / reloadNotes 唯一入口） ----
    // 一次返回全部页面状态，并把服务端字段归一化成客户端组件直接读的形状：
    // 账号补 xiaohongshuId/profileUrl/following/followers/likesAndCollects；
    // 笔记补 url/coverUrl/images/imageNotes/指标/accountNickname/accountXhsId；
    // 监测账号附带 notes（含 snapshots）与同名字段别名；
    // loginGate 补 status（'verified'）/verified/verifiedAt/at；
    // handshake 补 status（'verified'/'failed'/'unknown'）/at/message/ok/browserState。
    getstate() {
      const gate = resolveLoginGate()
      const settings = store.getSettings()
      const accounts = store.listAccounts()
      const accountById = new Map(accounts.map((a) => [a.id, a]))
      const primary =
        gate.accountId != null ? accountById.get(gate.accountId) ?? null : accounts[0] ?? null

      // 已拉笔记按 url 索引，供笔记库补指标与拉取时间。
      const fetchedByUrl = new Map()
      for (const account of accounts) {
        for (const fn of store.listFetchedNotes(account.id)) {
          if (fn.url) fetchedByUrl.set(fn.url, fn)
        }
      }

      const notes = store.listNotes().map((row) => {
        const base = noteRow(row)
        const account = base.accountId != null ? accountById.get(base.accountId) ?? null : null
        const fetched = base.sourceUrl ? fetchedByUrl.get(base.sourceUrl) ?? null : null
        let likes = null
        let collects = null
        let shares = null
        let comments = null
        let fetchedAt = null
        if (fetched) {
          likes = fetched.likes
          collects = fetched.collects
          shares = fetched.shares
          comments = fetched.comments
          fetchedAt = toIso(fetched.fetched_at)
        }
        // 指标仍为空时取该笔记的最新快照。
        if (likes == null && collects == null && shares == null && comments == null) {
          const snaps = store.listSnapshots(base.id)
          const latest = snaps[snaps.length - 1]
          if (latest) {
            likes = latest.likes
            collects = latest.collects
            shares = latest.shares
            comments = latest.comments
          }
        }
        const fetchedImages = base.fetchedImages || []
        const localImages = (base.imageIds || [])
          .map((assetId) => {
            const asset = store.getAsset(assetId)
            return { assetId, url: asset ? `${PREFIX}/assets/${asset.id}/content` : '' }
          })
          .filter((im) => im.url)
        const images = base.source === 'fetched' ? fetchedImages : localImages
        const coverUrl = fetchedImages[0] || (localImages[0] && localImages[0].url) || ''
        return {
          ...base,
          url: base.sourceUrl || '',
          coverUrl,
          images,
          imageNotes: base.imageCaptions || [],
          likes,
          collects,
          shares,
          comments,
          fetchedAt,
          accountNickname: account ? account.nickname : '',
          accountXhsId: account ? account.xhs_id : '',
        }
      })

      const monitoredAccounts = store.listMonitoredAccounts().map((row) => {
        const base = monitoredAccountRow(row, store.countMonitoredNotes(row.id))
        const notes = store.listMonitoredNotes(row.id).map((n) => {
          const nb = monitoredNoteRow(n)
          const snapshots = store.listMonitoredSnapshots(n.id).map((s) => ({
            at: toIso(s.captured_at),
            likes: s.likes,
            collects: s.collects,
            shares: s.shares,
            comments: s.comments,
          }))
          // Muse monitoredNoteShape：最新/上次指标 + 快照数。
          const sorted = [...snapshots].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
          const toMetrics = (s) =>
            s ? { likes: s.likes, collects: s.collects, shares: s.shares, comments: s.comments } : null
          return {
            ...nb,
            snapshots,
            latestMetrics: toMetrics(sorted[0]),
            previousMetrics: toMetrics(sorted[1]),
            snapshotCount: snapshots.length,
          }
        })
        return {
          ...base,
          xiaohongshuId: base.xhsId,
          redId: base.xhsId,
          profileUrl: base.homepage,
          following: base.followingCount,
          followers: base.followersCount,
          likesAndCollects: base.likesCollectsCount,
          avatar: base.avatarUrl,
          name: base.nickname,
          notes,
        }
      })

      const { notifications: competitorNotifications, unreadCount: competitorUnreadCount } =
        store.listCompetitorNotifications(50)
      const { requests: sharedRequests, pendingCount: sharedPendingCount } =
        store.listSharedSessionRequests()

      return {
        ok: true,
        accounts: accounts.map((a) => {
          const r = accountRow(a, store.countFetchedNotes(a.id))
          return {
            ...r,
            xiaohongshuId: r.xhsId,
            redId: r.xhsId,
            profileUrl: r.homepage,
            following: r.followingCount,
            followers: r.followersCount,
            likesAndCollects: r.likesCollectsCount,
            avatar: r.avatarUrl,
            name: r.nickname,
          }
        }),
        notes,
        monitoredAccounts,
        loginGate: {
          ...gate,
          status: gate.state === 'valid' ? 'verified' : gate.state,
          verified: gate.isLoggedIn,
          verifiedAt: gate.lastVerifiedAt,
          at: gate.lastHandshakeAt,
        },
        handshake: {
          status:
            gate.handshakeStatus === 'valid'
              ? 'verified'
              : gate.handshakeStatus === 'failed' || gate.handshakeStatus === 'expired'
                ? 'failed'
                : 'unknown',
          message: gate.handshakeMessage || '',
          at: gate.lastHandshakeAt,
          ok: gate.handshakeStatus === 'valid',
          browserState: gate.browserState,
        },
        dataFolder: settings.data_dir_label || '',
        fetchStatus: primary ? primary.fetch_status : 'idle',
        infoFetchStatus: primary ? primary.info_fetch_status : 'idle',
        hotspotFeed: loadHotspotFeed(),
        leadMonitor: loadLeadMonitor(),
        competitorNotifications: competitorNotifications.map(competitorNotificationRow),
        competitorUnreadCount,
        sharedRequests: sharedRequests.map(sharedSessionRequestRow),
        sharedPendingCount,
        imageGenSettings: getImageGenSettings(),
        onboarding: loadOnboardingState(),
      }
    },
    async handshakeloginsession() {
      const result = await handshakeTick()
      return { ok: true, ...result }
    },
    // 用户主动点的扫码登录入口（Muse requestQrLogin，force=true 口径）：
    // DSH 没有可派发的任务浏览器，所以“立马弹出”= 立即给用户打开
    // 登录页的直达链接（客户端 window.open），同时写 qrLastOpenedAt、
    // 登记一笔共用会话 account_info 请求（扫码也可能发生在用户可见
    // 的浏览器里，由 reportSharedSessionLogin 回写确认）。
    // started 的语义是“已为用户打开登录页入口”，绝不谎称“已派发后台任务”。
    // 文案不再写“已派发/浏览器正在打开”，只说链接已给出、扫码后怎么办。
    requestqrlogin() {
      const gate = resolveLoginGate()
      const primary =
        gate.accountId != null
          ? store.getAccount(gate.accountId)
          : store.listAccounts()[0] ?? null
      if (!primary) {
        return {
          ok: true,
          started: false,
          url: XHS_LOGIN_URL,
          loginUrl: XHS_LOGIN_URL,
          message:
            '还没有绑定账号，暂时打不开扫码登录。请先在「账号管理」页点「+ 绑定新账号」，绑定本身就会打开扫码登录页。',
          gate: resolveLoginGate(),
        }
      }
      store.writeGate(primary.id, { gate_qr_last_opened_at: nowMs() })
      store.upsertSharedRequest('account_info', {
        accountId: primary.id,
        message:
          '共用登录请求（用户在工作台点了「打开浏览器扫码登录」）：请在 Muse 聊天里让 Muse 在你能看到的浏览器里打开小红书登录页扫码，确认登录后由 Muse 回写共用会话状态。',
      })
      return {
        ok: true,
        started: true,
        url: XHS_LOGIN_URL,
        loginUrl: XHS_LOGIN_URL,
        message:
          '登录页入口已给出：点上方链接在浏览器里打开小红书登录页，用小红书 App 扫码并在手机上确认登录；登录成功后账号信息会自动读回来（也已登记共用会话请求：在 Muse 聊天里让 Muse 在你能看到的浏览器里打开登录页扫码，同样算登录成功）。',
        gate: resolveLoginGate(),
      }
    },
    // 「我已扫码，重新读取账号信息」（Muse confirmQrScanned）：
    // DSH 无任务浏览器可直接重读，所以本次点击只登记共用会话
    // account_info 请求（由已登录浏览器侧确认并回写），started=false
    // 如实说明“没有直接重读”，不谎称已派发读取任务。
    confirmqrscanned() {
      const gate = resolveLoginGate()
      const primary =
        gate.accountId != null
          ? store.getAccount(gate.accountId)
          : store.listAccounts()[0] ?? null
      if (!primary) {
        return {
          ok: true,
          started: false,
          message: '还没有绑定账号，没有可重新读取的账号信息。请先在「账号管理」页点「+ 绑定新账号」扫码绑定。',
          gate: resolveLoginGate(),
        }
      }
      store.upsertSharedRequest('account_info', {
        accountId: primary.id,
        message:
          '用户在工作台点了「我已扫码」：请在 Muse 聊天里确认你能看到的浏览器是否已登录小红书，并把账号信息读回工作台（共用会话回写）。',
      })
      return {
        ok: true,
        started: false,
        message:
          '已登记重新读取请求：DSH 这边没有可直接重读的浏览器，需要在已登录的浏览器里确认——回到 Muse 聊天里说一声，Muse 会在你能看到的浏览器里确认登录并把账号信息读回工作台；也可以等下一次握手自动确认。',
        gate: resolveLoginGate(),
      }
    },
    savehandshakeresult(body) {
      const conclusive = body.conclusive === true
      const browserLoggedIn = body.browserLoggedIn === true
      const message = clampStr(body.message ?? '', 500)
      const gateAccount = store.getGateAccount()
      if (!conclusive) {
        // inconclusive 握手绝不改变门禁。
        if (gateAccount) {
          store.writeGate(gateAccount.id, {
            gate_handshake_status: 'unknown',
            gate_handshake_task_id: '',
            gate_handshake_message:
              message || '握手结果无法确定，未改变登录门禁。',
            gate_last_handshake_at: nowMs(),
          })
        }
        return {
          ok: true,
          success: true,
          conclusive: false,
          gate: resolveLoginGate(),
          message: '握手结果无法确定，登录状态未改变。',
        }
      }
      if (browserLoggedIn) {
        applyConclusiveLoggedIn({
          nickname: clampStr(body.nickname ?? '', 60),
          xhsId: clampStr(body.xhsId ?? '', 60),
          homepage: clampStr(body.homepage ?? '', 1000),
        })
        return {
          ok: true,
          success: true,
          conclusive: true,
          gate: resolveLoginGate(),
          message: '已确认登录小红书。',
        }
      }
      const { qrAutoOpened, sharedProtects } = applyConclusiveLoggedOut()
      return {
        ok: true,
        success: true,
        conclusive: true,
        gate: resolveLoginGate(),
        message: sharedProtects
          ? '已确认任务浏览器登出，但共用会话仍登录，登录态保持已登录。'
          : qrAutoOpened
            ? '已确认登出，已自动唤起一次扫码登录。'
            : '已确认登出，请重新扫码登录。',
      }
    },
    // 旧任务兼容别名：verified 即 success，走同一 applyLoggedInInfo。
    saveloginverification(body) {
      const result = applyLoggedInInfo({
        accountId: body.accountId,
        success: body.verified === true,
        nickname: body.nickname,
        xhsId: body.xhsId,
        homepage: body.homepage,
        followingCount: body.followingCount,
        followersCount: body.followersCount,
        likesCollectsCount: body.likesCollectsCount,
        avatarUrl: body.avatarUrl,
        message: body.message,
      })
      const account = store.getAccount(body.accountId)
      return {
        ok: true,
        success: result.ok,
        account: account ? accountRow(account, store.countFetchedNotes(account.id)) : null,
        gate: resolveLoginGate(),
        message: result.ok ? '登录验证通过，已保存账号信息。' : result.message,
      }
    },
    saveloggedinaccountinfo(body) {
      const result = applyLoggedInInfo({
        accountId: body.accountId,
        success: body.success === true,
        nickname: body.nickname,
        xhsId: body.xhsId,
        homepage: body.homepage,
        followingCount: body.followingCount,
        followersCount: body.followersCount,
        likesCollectsCount: body.likesCollectsCount,
        avatarUrl: body.avatarUrl,
        message: body.message,
      })
      const account =
        result.accountId != null ? store.getAccount(result.accountId) : store.getAccount(body.accountId)
      return {
        ok: true,
        success: result.ok,
        account: account ? accountRow(account, store.countFetchedNotes(account.id)) : null,
        gate: resolveLoginGate(),
        message: result.ok ? '已保存登录账号信息。' : result.message,
      }
    },
    saveboundloggedinaccount(body) {
      if (body.success !== true) {
        return {
          ok: true,
          success: false,
          message: clampStr(body.message ?? '', 500) || '绑定失败，未读取到登录账号信息。',
        }
      }
      // 按 xhsId 匹配 / 待扫码占位 / 新建记录（Muse saveBoundLoggedInAccount）。
      const xhsId = clampStr(body.xhsId ?? '', 60).trim()
      const all = store.listAccounts()
      const byXhs = xhsId ? all.find((r) => r.xhs_id !== '' && r.xhs_id === xhsId) : undefined
      const placeholder = [...all]
        .reverse()
        .find(
          (r) =>
            r.nickname === '新账号 · 等待扫码登录' &&
            (r.info_fetch_status === 'fetching' || r.login_status === 'verifying'),
        )
      let targetId = byXhs?.id ?? placeholder?.id
      if (targetId === undefined) {
        const created = store.upsertAccount({
          nickname: '新账号 · 等待扫码登录',
          xhs_id: '',
          homepage: '',
          note: '',
          monitored: all.length === 0 ? 1 : 0,
          fetch_status: 'idle',
          fetch_message: LOGIN_GATE_MESSAGE,
        })
        targetId = created.id
      }
      const result = applyLoggedInInfo({ ...body, accountId: targetId, success: true })
      const account = store.getAccount(targetId)
      return {
        ok: true,
        success: result.ok,
        account: account ? accountRow(account, store.countFetchedNotes(account.id)) : null,
        gate: resolveLoginGate(),
        message: result.ok ? '已绑定登录账号。' : result.message,
      }
    },

    // ---- 已拉取笔记 ----
    listfetchednotes(body) {
      const accountId = body.accountId ?? null
      return {
        notes: store.listFetchedNotes(accountId).map(fetchedNoteRow),
      }
    },
    savefetchednotes(body) {
      const gate = resolveLoginGate()
      const account = store.getAccount(body.accountId)
      if (!account) {
        return { ok: true, success: false, message: '账号不存在，本次拉取结果已丢弃，未写入。' }
      }
      // 门禁校验（Muse saveFetchedNotes）：门禁账号不是目标账号时整批丢弃，
      // 并写 fetch_message（不删已存数据）。账号为空时丢弃并写失败消息。
      if (!gate.canFetch || !gateAllowsAccount(account.id)) {
        store.updateAccount(body.accountId, {
          fetch_status: 'failed',
          fetch_message: `拉取已完成，但未写入：${LOGIN_GATE_MESSAGE}`,
        })
        return {
          ok: true,
          success: false,
          message: `拉取已完成，但未写入：${LOGIN_GATE_MESSAGE}`,
        }
      }
      const incoming = Array.isArray(body.notes) ? body.notes.slice(0, 20) : []
      const incomingOwnerXhsId = clampStr(body.ownerXhsId ?? '', 60)
      const incomingOwnerNickname = clampStr(body.ownerNickname ?? '', 60)
      // 先按 Muse 口径确定归属目标：拉取结果属于已有绑定记录 → 移到它名下；
      // 属于未绑定过的小红书号 → 新建绑定记录；否则留在当前账号。
      let targetId = body.accountId
      if (incomingOwnerXhsId !== '' && incomingOwnerXhsId !== account.xhs_id) {
        const others = store
          .listAccounts()
          .filter((a) => a.xhs_id !== '' && a.xhs_id === incomingOwnerXhsId)
        if (others.length > 0) {
          targetId = others[0].id
        } else {
          targetId = store.upsertAccount({
            nickname: incomingOwnerNickname || '已登录账号',
            xhs_id: incomingOwnerXhsId,
            homepage: account.homepage,
            note: '',
            monitored: 0,
            fetch_status: 'idle',
            fetch_message: LOGIN_GATE_MESSAGE,
            login_status: 'verified',
          }).id
        }
      }
      const { saved, previous } = store.replaceFetchedNotes(targetId, incoming)
      store.updateAccount(targetId, {
        nickname:
          incomingOwnerNickname !== '' ? incomingOwnerNickname : store.getAccount(targetId).nickname,
        xhs_id:
          incomingOwnerXhsId !== '' ? incomingOwnerXhsId : store.getAccount(targetId).xhs_id,
        fetch_status: 'done',
        fetch_task_id: '',
        fetch_message: clampStr(body.message ?? '', 500),
        fetched_at: nowMs(),
      })
      if (targetId !== body.accountId) {
        store.updateAccount(body.accountId, {
          fetch_status: 'done',
          fetch_task_id: '',
          fetch_message: clampStr(body.message ?? '', 500),
          fetched_at: nowMs(),
        })
      }
      store.fulfillSharedRequests(
        'account_notes',
        { accountId: body.accountId },
        '已拉取并回写该账号的真实笔记。',
      )
      // 留资：评论增量比对（与替换前存量比，两侧已知且严格增加才报）。
      let commentNotified = 0
      for (const next of saved) {
        const prev = previous.find((p) =>
          next.url ? p.url !== '' && p.url === next.url : p.title !== '' && p.title === next.title,
        )
        if (!prev) continue
        if (prev.comments != null && next.comments != null && next.comments > prev.comments) {
          commentNotified += 1
        }
        store.noteLeadCommentIncrease(next.title, next.url, prev.comments, next.comments)
      }
      return {
        ok: true,
        success: true,
        saved: saved.length,
        accountId: targetId,
        commentNotified,
        message: `已保存 ${saved.length} 篇笔记。`,
      }
    },
    cleanupunverifiedfetchednotes() {
      const gate = resolveLoginGate()
      if (gate.accountId == null) {
        return { ok: true, removedFetchedRows: 0, removedNotes: 0, message: '没有已验证的绑定账号，无需清理。' }
      }
      const { removedFetchedRows, removedNotes } = store.cleanupUnverifiedFetchedNotesFor(gate.accountId)
      return {
        ok: true,
        removedFetchedRows,
        removedNotes,
        message: `已清理 ${removedFetchedRows} 篇未验证账号的已拉笔记与 ${removedNotes} 篇笔记库镜像。`,
      }
    },
    savenoteimages(body) {
      const account = store.getAccount(body.accountId)
      if (!account) {
        return { ok: true, success: false, message: '账号不存在，本次配图结果未写入。' }
      }
      if (body.success !== true) {
        // 只动 image 管线，永不擦除已记录的登录确认。
        store.updateAccount(body.accountId, {
          image_fetch_status: 'failed',
          image_fetch_task_id: '',
          image_fetch_message: clampStr(body.message ?? '', 500) || '读取笔记配图失败。',
        })
        return {
          ok: true,
          success: false,
          message: clampStr(body.message ?? '', 500) || '读取笔记配图失败。',
        }
      }
      if (!gateAllowsAccount(account.id)) {
        store.updateAccount(body.accountId, {
          image_fetch_status: 'failed',
          image_fetch_task_id: '',
          image_fetch_message: `配图已读回，但未写入：${LOGIN_GATE_MESSAGE}`,
        })
        return {
          ok: true,
          success: false,
          message: `配图已读回，但未写入：${LOGIN_GATE_MESSAGE}`,
        }
      }
      const updated = store.saveNoteImages(
        body.accountId,
        Array.isArray(body.items) ? body.items.slice(0, 20) : [],
      )
      // 配图回填后同步笔记库镜像的 fetched_images_json。
      store.syncFetchedNoteMirrorImages(body.accountId)
      store.updateAccount(body.accountId, {
        image_fetch_status: 'done',
        image_fetch_task_id: '',
        image_fetch_message: clampStr(body.message ?? '', 500),
      })
      store.fulfillSharedRequests(
        'note_images',
        { accountId: body.accountId },
        '已补拉并回写该账号笔记的配图。',
      )
      return { ok: true, success: true, updated, message: `已写回 ${updated} 篇笔记的配图。` }
    },
    // 详情回填的回写（新动作）：逐篇写回发布时间与收藏/分享/评论数，
    // 绝不删不重建（就地回填）；complete=false 时只更新进度，
    // complete=true 时置 done 并 fulfill note_details 请求。
    savenotedetails(body) {
      const account = store.getAccount(body.accountId)
      if (!account) {
        return { ok: true, success: false, message: '账号不存在，本次详情回填未写入。' }
      }
      const items = Array.isArray(body.items) ? body.items.slice(0, 30) : []
      const message = clampStr(body.message ?? '', 500)
      if (body.success !== true) {
        store.updateAccount(body.accountId, {
          detail_fetch_status: 'failed',
          detail_fetch_task_id: '',
          detail_fetch_message: message || '读取笔记详情失败。',
        })
        return { ok: true, success: false, message: message || '读取笔记详情失败。' }
      }
      if (!gateAllowsAccount(account.id)) {
        store.updateAccount(body.accountId, {
          detail_fetch_status: 'failed',
          detail_fetch_task_id: '',
          detail_fetch_message: `详情已读回，但未写入：${LOGIN_GATE_MESSAGE}`,
        })
        return {
          ok: true,
          success: false,
          message: `详情已读回，但未写入：${LOGIN_GATE_MESSAGE}`,
        }
      }
      // 进度口径与 Muse saveNoteDetails 一致：调用方报的 doneCount/totalCount
      // 才是进度（complete=false 时 done 取 max(已存, doneCount)；complete=true
      // 时 done 写满 total、total 列本身不动，绝不清零）。
      const doneCount = Number.isInteger(body.doneCount) && body.doneCount >= 0 ? body.doneCount : 0
      const totalCount =
        Number.isInteger(body.totalCount) && body.totalCount >= 0 ? body.totalCount : 0
      if (body.complete !== true) {
        const progress = store.saveNoteDetails(body.accountId, items)
        store.updateAccount(body.accountId, {
          detail_fetch_status: 'fetching',
          detail_fetch_message:
            message ||
            `正在逐篇打开详情页补发布日期和数据：已处理 ${doneCount}${totalCount > 0 ? ` / ${totalCount}` : ''} 篇…`,
          detail_fetch_total: totalCount > 0 ? totalCount : account.detail_fetch_total,
          detail_fetch_done: Math.max(account.detail_fetch_done ?? 0, doneCount),
        })
        return {
          ok: true,
          success: true,
          complete: false,
          updated: progress.dated + progress.metricsFilled,
        }
      }
      const progress = store.saveNoteDetails(body.accountId, items)
      const total =
        account.detail_fetch_total > 0 ? account.detail_fetch_total : totalCount
      store.updateAccount(body.accountId, {
        detail_fetch_status: 'done',
        detail_fetch_task_id: '',
        detail_fetch_message:
          message ||
          (progress.dated > 0 || progress.metricsFilled > 0
            ? `补读完成：为 ${progress.dated} 篇笔记补上了发布日期，为 ${progress.metricsFilled} 篇补上了详情页数据。仍读不到发布时间的笔记会留在「日期未知」里。`
            : '这次没有读到新的发布日期或数据；仍缺日期的笔记会留在「日期未知」里，下次可以再补一次。'),
        detail_fetch_done: total,
      })
      store.fulfillSharedRequests(
        'note_details',
        { accountId: body.accountId },
        '已补齐该账号笔记的发布日期与详情数据。',
      )
      return {
        ok: true,
        success: true,
        complete: true,
        updated: progress.dated + progress.metricsFilled,
      }
    },
    // 详情回填进度同步（新动作）：无任务状态可查时只做 10 分钟超时自清。
    syncnotedetailfetchstatuses() {
      syncInfoFetchTimeout()
      syncHandshakeTimeout()
      return { ok: true, synced: 0 }
    },

    // ---- 笔记库（草稿 / 已发布） ----
    listnotes() {
      return { ok: true, notes: store.listNotes().map(noteRow) }
    },
    createnote(body) {
      const note = store.createNote({
        account_id: body.accountId ?? null,
        title: clampStr(body.title ?? '', 100),
        body: clampStr(body.body ?? '', 5000),
        tags_json: JSON.stringify(
          (Array.isArray(body.tags) ? body.tags : []).slice(0, 20).map((t) => String(t).slice(0, 40)),
        ),
        topic: '',
        status: 'draft',
        image_ids_json: JSON.stringify(
          (Array.isArray(body.imageIds) ? body.imageIds : []).slice(0, 18),
        ),
        image_captions_json: '[]',
        fetched_images_json: '[]',
        source: 'local',
        source_url: '',
        published_at: null,
      })
      return { id: note.id }
    },
    updatenote(body) {
      const note = store.getNote(body.id)
      if (!note) return { ok: false, message: '笔记不存在。' }
      const patch = {}
      if (body.accountId !== undefined) patch.account_id = body.accountId
      if (body.title !== undefined) patch.title = clampStr(body.title, 100)
      if (body.body !== undefined) patch.body = clampStr(body.body, 5000)
      if (body.tags !== undefined) {
        patch.tags_json = JSON.stringify(
          (Array.isArray(body.tags) ? body.tags : [])
            .slice(0, 20)
            .map((t) => String(t).slice(0, 40)),
        )
      }
      if (body.imageIds !== undefined) {
        patch.image_ids_json = JSON.stringify(
          (Array.isArray(body.imageIds) ? body.imageIds : []).slice(0, 18),
        )
      }
      if (body.imageCaptions !== undefined) {
        patch.image_captions_json = JSON.stringify(
          (Array.isArray(body.imageCaptions) ? body.imageCaptions : [])
            .slice(0, 18)
            .map((c) => String(c).slice(0, 200)),
        )
      }
      const updated = store.updateNote(body.id, patch)
      return { ok: true, note: noteRow(updated), message: '笔记已保存。' }
    },
    deletenote(body) {
      const note = store.getNote(body.id)
      if (!note) return { ok: false, message: '笔记不存在。' }
      store.deleteNote(body.id)
      return { ok: true, message: '笔记已删除。' }
    },
    publishnote(body) {
      const note = store.getNote(body.id)
      if (!note) return { ok: false, message: '笔记不存在。' }
      const updated = store.updateNote(body.id, {
        status: 'published',
        published_at: nowMs(),
      })
      store.fulfillSharedRequests('publish_note', { noteId: body.id }, '已发布到小红书。')
      return {
        ok: true,
        publishedAt: toIso(updated.published_at),
        note: noteRow(updated),
        message: '笔记已标记为已发布。',
      }
    },
    unpublishnote(body) {
      const note = store.getNote(body.id)
      if (!note) return { ok: false, message: '笔记不存在。' }
      const updated = store.updateNote(body.id, { status: 'draft', published_at: null })
      return { ok: true, note: noteRow(updated), message: '笔记已改回草稿。' }
    },
    generatenote(body) {
      return generateNote({
        topic: body.topic,
        keywords: body.keywords,
        style: body.style,
        accountId: body.accountId ?? null,
        images: body.images ?? [],
      })
    },

    // ---- 素材库 ----
    listassets() {
      return { ok: true, assets: store.listAssets().map(assetRow) }
    },
    importasset(body) {
      const name = clampStr(body.name ?? '', 200)
      if (!name) return { ok: false, message: '图片名称不能为空。' }
      if (!body.dataBase64 || typeof body.dataBase64 !== 'string') {
        return { ok: false, message: '图片数据不能为空。' }
      }
      let buffer
      try {
        buffer = Buffer.from(body.dataBase64, 'base64')
      } catch {
        return { ok: false, message: '图片数据不是有效的 Base64，请重新选择文件。' }
      }
      if (buffer.length === 0) return { ok: false, message: '图片数据为空，请重新选择文件。' }
      const mimeType = clampStr(body.mimeType ?? 'image/jpeg', 60) || 'image/jpeg'
      const ext =
        mimeType === 'image/png'
          ? '.png'
          : mimeType === 'image/webp'
            ? '.webp'
            : mimeType === 'image/gif'
              ? '.gif'
              : '.jpg'
      const blobKey = `${randomUUID()}${ext}`
      store.saveBlobFile(blobKey, buffer)
      const asset = store.createAsset({
        name,
        relative_path: clampStr(body.relativePath ?? '', 500),
        folder_label: clampStr(body.folderLabel ?? '', 300),
        mime_type: mimeType,
        size_bytes: buffer.length,
        blob_key: blobKey,
      })
      return { ok: true, asset: assetRow(asset), message: '图片已导入素材库。' }
    },
    deleteasset(body) {
      const asset = store.getAsset(body.id)
      if (!asset) return { ok: false, message: '素材不存在。' }
      store.deleteAsset(body.id)
      return { ok: true, message: '素材已删除。' }
    },

    // ---- 数据监测 ----
    recordmetrics(body) {
      const note = store.getNote(body.noteId)
      if (!note) return { ok: false, message: '笔记不存在。' }
      for (const key of ['likes', 'collects', 'shares', 'comments']) {
        const value = body[key]
        if (value != null && (!Number.isInteger(value) || value < 0)) {
          return { ok: false, message: '指标必须为不小于 0 的整数。' }
        }
      }
      const snapshot = store.recordSnapshot(body.noteId, {
        likes: intOrDefault(body.likes, 0),
        collects: intOrDefault(body.collects, 0),
        shares: intOrDefault(body.shares, 0),
        comments: intOrDefault(body.comments, 0),
      })
      return { ok: true, snapshot: snapshotRow(snapshot), message: '指标快照已记录。' }
    },
    listsnapshots(body) {
      if (body.noteId == null) return { ok: false, message: '缺少笔记编号。' }
      return {
        ok: true,
        snapshots: store.listSnapshots(body.noteId).map(snapshotRow),
      }
    },
    listmonitoredaccounts() {
      return {
        ok: true,
        monitoredAccounts: store
          .listMonitoredAccounts()
          .map((a) => monitoredAccountRow(a, store.countMonitoredNotes(a.id))),
      }
    },
    addmonitoredaccount(body) {
      const homepage = normalizeHomepageUrl(body.homepage ?? '')
      if (!homepage) {
        return {
          ok: false,
          message:
            '请粘贴有效的小红书账号主页链接（例如 https://www.xiaohongshu.com/user/profile/xxxxxxxx）。',
        }
      }
      const afterProfile = homepage.split('/user/profile/')[1] ?? ''
      const xhsId = afterProfile.split(/[/?#]/)[0] ?? ''
      const existing =
        store.getMonitoredAccountByHomepage(homepage) ??
        (xhsId
          ? store.listMonitoredAccounts().find((a) => a.xhs_id !== '' && a.xhs_id === xhsId)
          : undefined)
      if (existing) {
        // 已存在时返回该账号并重新拉取（走共用会话/桥口径）。
        const res = startSharedOrBridge(
          'monitored_account',
          { monitoredAccountId: existing.id },
          '重新拉取这个监测账号的最新笔记',
        )
        return {
          ok: true,
          exists: true,
          started: res.shared,
          monitoredAccount: monitoredAccountRow(
            store.getMonitoredAccount(existing.id),
            store.countMonitoredNotes(existing.id),
          ),
          message: res.shared
            ? '该监测账号已存在，已登记重新拉取请求（在已登录的浏览器里拉取）。'
            : `该监测账号已存在：${res.message}`,
        }
      }
      const created = store.upsertMonitoredAccount({
        nickname: '',
        xhs_id: xhsId,
        homepage,
        fetch_status: 'idle',
      })
      const res = startSharedOrBridge(
        'monitored_account',
        { monitoredAccountId: created.id },
        '拉取这个监测账号的最新笔记',
      )
      return {
        ok: true,
        exists: false,
        id: created.id,
        started: res.shared,
        reason: res.shared ? undefined : res.message,
        monitoredAccount: monitoredAccountRow(created, 0),
        message: res.shared
          ? '已添加监测账号，已登记拉取请求（在已登录的浏览器里拉取）。'
          : `已添加监测账号，但暂未开始拉取：${res.message}`,
      }
    },
    deletemonitoredaccount(body) {
      const account = store.getMonitoredAccount(body.id)
      if (!account) return { ok: false, message: '监测账号不存在。' }
      store.deleteMonitoredAccount(body.id)
      return { ok: true, message: '监测账号已删除。' }
    },
    // Muse setMonitoredAccount：操作的是 accounts 表的 monitored 标志
    // （选哪个绑定账号作为“当前监测对象”），不是监测账号表。
    setmonitoredaccount(body) {
      const account = store.getAccount(body.id)
      if (!account) return { ok: false, message: '账号不存在。' }
      store.setMonitoredAccount(body.id)
      return {
        ok: true,
        account: accountRow(store.getAccount(body.id), store.countFetchedNotes(body.id)),
        message: '已切换当前账号。',
      }
    },
    startfetchmonitoredaccount(body) {
      const account = store.getMonitoredAccount(body.monitoredAccountId)
      if (!account) return { ok: false, message: '监测账号不存在。' }
      const gate = resolveLoginGate()
      if (!gate.canFetch) {
        return notStarted(`登录门禁未通过：${gate.message}`)
      }
      const res = startSharedOrBridge(
        'monitored_account',
        { monitoredAccountId: account.id },
        '拉取这个监测账号的最新笔记',
      )
      return notStarted(res.message)
    },
    savemonitoredaccountfetch(body) {
      const account = store.getMonitoredAccount(body.monitoredAccountId)
      if (!account) {
        return { ok: true, success: false, message: '监测账号不存在，本次结果未写入。' }
      }
      if (body.success !== true) {
        // 只动监测管线。
        store.updateMonitoredAccount(body.monitoredAccountId, {
          fetch_status: 'failed',
          fetch_task_id: '',
          fetch_message: clampStr(body.message ?? '', 500) || '拉取监测账号失败。',
        })
        return {
          ok: true,
          success: false,
          message: clampStr(body.message ?? '', 500) || '拉取监测账号失败。',
        }
      }
      // 门禁校验改用“任一绑定账号已登录”。
      if (!resolveLoginGate().canFetch) {
        store.updateMonitoredAccount(body.monitoredAccountId, {
          fetch_status: 'failed',
          fetch_task_id: '',
          fetch_message: `监测结果已读回，但未写入：${LOGIN_GATE_MESSAGE}`,
        })
        return {
          ok: true,
          success: false,
          message: `监测结果已读回，但未写入：${LOGIN_GATE_MESSAGE}`,
        }
      }
      const patch = {
        nickname: clampStr(body.nickname ?? '', 60) || account.nickname,
        xhs_id: clampStr(body.xhsId ?? '', 60) || account.xhs_id,
        homepage: clampStr(body.homepage ?? '', 1000) || account.homepage,
        fetch_status: 'done',
        fetch_task_id: '',
        fetch_message: clampStr(body.message ?? '', 500),
        fetched_at: nowMs(),
      }
      // 计数只在本次读到时才覆盖；头像只在本次读到时才覆盖。
      if (body.followingCount != null) patch.following_count = intOrNull(body.followingCount)
      if (body.followersCount != null) patch.followers_count = intOrNull(body.followersCount)
      if (body.likesCollectsCount != null)
        patch.likes_collects_count = intOrNull(body.likesCollectsCount)
      const avatarUrl = clampStr(body.avatarUrl ?? '', 2000)
      if (avatarUrl) patch.avatar_source_url = avatarUrl
      store.updateMonitoredAccount(body.monitoredAccountId, patch)
      const notes = Array.isArray(body.notes) ? body.notes.slice(0, 5) : []
      const { saved, candidates, hadBaseline } = store.applyMonitoredFetch(
        body.monitoredAccountId,
        notes,
      )
      store.generateCompetitorNotifications(
        body.monitoredAccountId,
        candidates,
        hadBaseline,
        store.getMonitoredAccount(body.monitoredAccountId).nickname || '监测账号',
      )
      store.fulfillSharedRequests(
        'monitored_account',
        { monitoredAccountId: body.monitoredAccountId },
        '已拉取并回写该监测账号的最新笔记。',
      )
      return {
        ok: true,
        success: true,
        saved,
        monitoredAccount: monitoredAccountRow(
          store.getMonitoredAccount(body.monitoredAccountId),
          store.countMonitoredNotes(body.monitoredAccountId),
        ),
        message: `已保存监测账号的 ${saved} 篇笔记。`,
      }
    },
    listmonitorednotes(body) {
      if (body.monitoredAccountId == null) {
        return { ok: false, message: '缺少监测账号编号。' }
      }
      return {
        notes: store.listMonitoredNotes(body.monitoredAccountId).map((n) => {
          const nb = monitoredNoteRow(n)
          const snapshots = store.listMonitoredSnapshots(n.id).map((s) => ({
            at: toIso(s.captured_at),
            likes: s.likes,
            collects: s.collects,
            shares: s.shares,
            comments: s.comments,
          }))
          const sorted = [...snapshots].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
          const toMetrics = (s) =>
            s
              ? { likes: s.likes, collects: s.collects, shares: s.shares, comments: s.comments }
              : null
          return {
            ...nb,
            snapshots,
            latestMetrics: toMetrics(sorted[0]),
            previousMetrics: toMetrics(sorted[1]),
            snapshotCount: snapshots.length,
          }
        }),
      }
    },
    listmonitoredsnapshots(body) {
      if (body.monitoredNoteId == null) {
        return { ok: false, message: '缺少监测笔记编号。' }
      }
      return {
        snapshots: store
          .listMonitoredSnapshots(body.monitoredNoteId)
          .map(monitoredSnapshotRow),
      }
    },

    // ---- 竞对通知 ----
    listcompetitornotifications(body) {
      const { notifications, unreadCount } = store.listCompetitorNotifications(
        Number.isInteger(body?.limit) && body.limit > 0 ? Math.min(body.limit, 200) : 50,
      )
      return {
        ok: true,
        notifications: notifications.map(competitorNotificationRow),
        unreadCount,
      }
    },
    markcompetitornotificationread(body) {
      store.markCompetitorNotificationRead(body.id)
      const { unreadCount } = store.listCompetitorNotifications(1)
      return { ok: true, unreadCount }
    },
    markallcompetitornotificationsread() {
      store.markAllCompetitorNotificationsRead()
      return { ok: true, unreadCount: 0 }
    },

    // ---- 留资管理 ----
    getleadmonitor() {
      return { monitor: loadLeadMonitor() }
    },
    startleaddmcheck() {
      const gate = resolveLoginGate()
      if (!gate.canFetch) {
        return notStarted(`登录门禁未通过：${gate.message}`)
      }
      const res = startLeadDmCheckTask()
      return notStarted(res.message)
    },
    saveleaddmcheck(body) {
      if (!resolveLoginGate().canFetch) {
        return {
          ok: true,
          success: false,
          message: `私信检查结果未写入：${LOGIN_GATE_MESSAGE}`,
        }
      }
      if (body.success !== true) {
        store.updateLeadState({
          dm_status: 'failed',
          dm_task_id: '',
          dm_message: clampStr(body.message ?? '', 500) || '检查私信失败。',
        })
        return {
          ok: true,
          success: false,
          message: clampStr(body.message ?? '', 500) || '检查私信失败。',
        }
      }
      const result = store.applyLeadDmCheck(
        Array.isArray(body.conversations) ? body.conversations : [],
        intOrDefault(body.unreadTotal, 0),
      )
      store.fulfillSharedRequests('lead_dm', {}, '已检查小红书私信并回写。')
      const unreadTotal = intOrDefault(body.unreadTotal, 0)
      return {
        ok: true,
        success: true,
        saved: result.saved,
        notified: result.notified,
        message: `已检查私信，未读 ${unreadTotal} 条${result.notified > 0 ? `，新增 ${result.notified} 条提醒` : '，无新提醒'}。`,
      }
    },
    syncleaddmstatuses() {
      syncHandshakeTimeout()
      return { ok: true, ...loadLeadMonitor() }
    },
    listleadnotifications(body) {
      const { notifications, unreadCount } = store.listLeadNotifications(
        Number.isInteger(body?.limit) && body.limit > 0 ? Math.min(body.limit, 200) : 50,
      )
      return {
        ok: true,
        notifications: notifications.map(leadNotificationRow),
        unreadCount,
      }
    },
    markleadnotificationread(body) {
      store.markLeadNotificationRead(body.id)
      const { unreadCount } = store.listLeadNotifications(1)
      return { ok: true, unreadCount }
    },
    markallleadnotificationsread() {
      store.markAllLeadNotificationsRead()
      return { ok: true, unreadCount: 0 }
    },

    // ---- 热点资讯 ----
    gethotspotfeed() {
      return { feed: loadHotspotFeed() }
    },
    updatehotspotconfig(body) {
      const patch = {}
      // 关键词去重保序（Muse updateHotspotConfig 口径；每项 trim 后 1–50 字，最多 20 个）。
      const keywords = []
      if (Array.isArray(body.keywords)) {
        for (const k of body.keywords) {
          const t = String(k).trim().slice(0, 50)
          if (t && !keywords.includes(t)) keywords.push(t)
          if (keywords.length >= 20) break
        }
        patch.hotspot_keywords_json = JSON.stringify(keywords)
      }
      const interval = body.intervalHours ?? body.interval_hours
      if (interval !== undefined) {
        const hours = Number(interval)
        if (Number.isInteger(hours) && hours >= 1 && hours <= 24) {
          patch.hotspot_interval_hours = hours
        }
      }
      if (body.enabled !== undefined) {
        patch.hotspot_enabled = body.enabled ? 1 : 0
      }
      store.updateSettings(patch)
      const next = store.getHotspotConfig()
      return {
        ok: true,
        config: next,
        message: `热点关键词已保存（${next.keywords.length} 个），小红书每 ${next.intervalHours} 小时检索一次。`,
      }
    },
    // 清单 §1 #63：{ ok, startedXhs, startedX, message }；source 为
    // xiaohongshu / x / both，both 时两源各试一次（小红书不过门禁也不挡 X）。
    starthotspotsearch(body) {
      const source =
        body.source === 'x' ? 'x' : body.source === 'both' ? 'both' : 'xiaohongshu'
      const wantXhs = source !== 'x'
      const wantX = source !== 'xiaohongshu'
      let startedXhs = false
      let startedX = false
      const bits = []
      if (wantXhs) {
        const res = startHotspotXhsSearchWithMessage()
        startedXhs = res.started
        bits.push(
          startedXhs
            ? '小红书检索已开始'
            : `小红书这次没能开始：${res.message || '请稍后再试'}`,
        )
      }
      if (wantX) {
        const started = startHotspotXSearch()
        startedX = started
        const state = store.getHotspotState()
        bits.push(
          started
            ? 'X 检索已开始'
            : `X 这次没能开始：${humanizeTaskFailure(state.x_message) || '请稍后再试'}`,
        )
      }
      return { ok: true, startedXhs, startedX, message: bits.join('；') }
    },
    savehotspotitems(body) {
      // 入库口径与表 DDL / 清单 §2.11 一致：source 只能是 'xiaohongshu' 或 'x'
      //（之前这里归一化成 'xhs'，与 CHECK (source IN ('xiaohongshu','x')) 冲突，
      // 小红书源每次插入都报 CHECK 约束失败）。
      const source = body.source === 'x' ? 'x' : 'xiaohongshu'
      const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []
      const now = nowMs()
      if (source === 'x' && body.xLoggedIn === true) {
        store.updateHotspotState({
          x_login_status: 'logged_in',
          x_login_checked_at: now,
          x_login_check_method: 'search',
          x_login_message: '最近一次 X 检索前随机浏览确认已登录。',
        })
      } else if (source === 'x' && body.xLoggedIn === false) {
        store.updateHotspotState({
          x_login_status: 'logged_out',
          x_login_message: clampStr(body.message ?? '', 500) || 'X 未登录，检索失败。',
        })
      }
      if (body.success === false) {
        store.updateHotspotState({
          ...(source === 'xiaohongshu'
            ? {
                xhs_status: 'failed',
                xhs_message: clampStr(body.message ?? '', 500) || '小红书热点检索失败。',
              }
            : {
                x_status: 'failed',
                x_message: clampStr(body.message ?? '', 500) || 'X 热点检索失败。',
              }),
        })
        return { ok: true, success: false, saved: 0, message: '检索失败，未存入资讯。' }
      }
      if (source === 'xiaohongshu' && !resolveLoginGate().canFetch) {
        return {
          ok: true,
          success: false,
          saved: 0,
          message: `热点检索结果未写入：${LOGIN_GATE_MESSAGE}`,
        }
      }
      const saved = store.saveHotspotItems(source, items)
      const statePatch =
        source === 'xiaohongshu'
          ? {
              xhs_status: 'done',
              xhs_last_fetched_at: now,
              xhs_last_attempt_at: now,
              xhs_message: clampStr(body.message ?? '', 500),
            }
          : {
              x_status: 'done',
              x_last_fetched_at: now,
              x_last_attempt_at: now,
              x_message: clampStr(body.message ?? '', 500),
            }
      store.updateHotspotState(statePatch)
      if (source === 'xiaohongshu') {
        store.fulfillSharedRequests('hotspot_xhs', {}, '已按关键词检索并回写小红书热点资讯。')
      }
      return { ok: true, success: true, saved, message: `已存入 ${saved} 条热点资讯。` }
    },
    startxlogin() {
      // DSH 无可派发的浏览器任务：started=false 如实说明，登录页入口随
      // loginUrl 给出（用户自己在浏览器里用邮箱密码登录 X）。
      startXLoginTask()
      return {
        ok: true,
        started: false,
        message:
          '已给出 X 登录页入口：点链接在浏览器里打开 X 登录页，用你自己的邮箱和密码登录 X（密码只输进 X 的登录页，工作台不会保存），登录完成这里会自动更新。',
        loginUrl: X_LOGIN_URL,
        url: X_LOGIN_URL,
      }
    },
    savexloginresult(body) {
      if (body.success !== true) {
        store.updateHotspotState({
          x_login_status: 'logged_out',
          x_login_message: clampStr(body.message ?? '', 500) || 'X 登录失败。',
        })
        return { ok: true, success: false, message: 'X 登录失败。' }
      }
      store.updateHotspotState({
        x_login_status: 'logged_in',
        x_login_checked_at: nowMs(),
        x_login_check_method: 'user_opened',
        x_login_message: '已确认登录 X。',
      })
      return { ok: true, success: true, message: '已确认登录 X。' }
    },
    checkxloginstatus() {
      // DSH 无可派发的浏览器任务：started=false 如实说明，不假装已开始检查。
      startXLoginCheckTask()
      return {
        ok: true,
        started: false,
        message: bridgeNotPairedMessage('用随机浏览检查 X 登录态'),
        loginUrl: X_LOGIN_URL,
        url: X_LOGIN_URL,
      }
    },
    savexlogincheckresult(body) {
      const state = store.getHotspotState()
      if (body.conclusive !== true) {
        // 无法确定时不覆盖已确认的 X 登录态，只记一次随机浏览结论不明。
        store.updateHotspotState({
          x_login_message:
            state.x_login_status === 'logged_in'
              ? state.x_login_message
              : '随机浏览无法确定 X 是否登录，登录态未改变。',
        })
        return {
          ok: true,
          success: true,
          conclusive: false,
          message: '随机浏览无法确定 X 是否登录，登录态未改变。',
        }
      }
      if (body.loggedIn === true) {
        store.updateHotspotState({
          x_login_status: 'logged_in',
          x_login_checked_at: nowMs(),
          x_login_check_method: 'random_browse',
          x_login_message: '随机浏览确认已登录 X。',
        })
        return { ok: true, success: true, conclusive: true, message: '已确认登录 X。' }
      }
      store.updateHotspotState({
        x_login_status: 'logged_out',
        x_login_check_method: 'random_browse',
        x_login_message: '随机浏览确认 X 未登录，请先登录 X。',
      })
      return { ok: true, success: true, conclusive: true, message: 'X 未登录，请先登录 X。' }
    },

    // ---- 生图 ----
    // 清单 §1 #35 / Muse getImageGenSettings：平铺 7 字段，无 ok/settings 包装，
    // apiKeyUpdatedAt 为 ISO 字符串或 null（见 core getImageGenSettingsFromStore）。
    getimagegensettings() {
      return getImageGenSettings()
    },
    updateimagegensettings(body) {
      const patch = {}
      if (body.preferredBackend !== undefined) {
        const backend = String(body.preferredBackend)
        if (['muse', 'dsh', 'api'].includes(backend)) patch.preferred_image_backend = backend
      }
      if (body.apiBaseUrl !== undefined) {
        patch.image_api_base_url = clampStr(body.apiBaseUrl ?? '', 500)
      }
      if (body.apiModel !== undefined) {
        patch.image_api_model = clampStr(body.apiModel ?? '', 200)
      }
      const apiKey = body.apiKey
      if (typeof apiKey === 'string' && apiKey.trim() !== '') {
        patch.image_api_key = apiKey.trim()
        patch.image_api_key_updated_at = nowMs()
      }
      if (body.clearApiKey === true) {
        patch.image_api_key = ''
        patch.image_api_key_updated_at = nowMs()
      }
      if (body.clearAll === true) {
        patch.image_api_key = ''
        patch.image_api_base_url = ''
        patch.image_api_model = ''
        patch.image_api_key_updated_at = nowMs()
      }
      store.updateSettings(patch)
      return {
        ok: true,
        settings: getImageGenSettings(),
        message: '生图设置已保存。',
      }
    },
    testimagegenapi() {
      return testImageGenApi()
    },
    async generateimage(body) {
      return generateImage({
        prompt: clampStr(body.prompt ?? '', 1000),
        backend: body.backend,
        style: clampStr(body.style ?? '', 20),
        topic: clampStr(body.topic ?? '', 200),
      })
    },

    // ---- 首次使用 / 共用会话 ----
    getonboardingstate() {
      return { onboarding: loadOnboardingState() }
    },
    // 清单 §1 #70：{ ok, startedXhs, startedX, message, onboarding }。
    // 另保留 started（DSH 口径：登录页入口已给出即 true，见 requestQrLogin；
    // 冒烟脚本 A11/A13 也按 started 判断“不再唤起”）。
    startfirstuselogin() {
      const state = loadOnboardingState()
      if (!state.isFirstUse) {
        return {
          ok: true,
          started: false,
          startedXhs: false,
          startedX: false,
          message: '已完成首次登录引导，无需再次唤起。',
          onboarding: state,
        }
      }
      const gate = resolveLoginGate()
      const primary =
        gate.accountId != null
          ? store.getAccount(gate.accountId)
          : store.listAccounts()[0] ?? null
      if (primary) {
        store.upsertSharedRequest('account_info', {
          accountId: primary.id,
          message:
            '首次使用登录引导：在 Muse 聊天里让 Muse 在你能看到的浏览器里打开小红书登录页扫码，确认登录后由 Muse 回写共用会话状态。',
        })
      }
      store.updateSettings({ first_use_login_prompted_at: nowMs() })
      return {
        ok: true,
        started: true,
        // DSH 无可派发的浏览器任务，两路登录都只给入口、未真正启动任务。
        startedXhs: false,
        startedX: false,
        loginUrl: XHS_LOGIN_URL,
        xLoginUrl: X_LOGIN_URL,
        message:
          '首次使用：已给出小红书登录页入口（点链接在浏览器里打开，用小红书 App 扫码登录）；X 也可在登录页入口打开后自行登录。登录成功后账号信息会自动读回。',
        onboarding: loadOnboardingState(),
      }
    },
    synchotspotsearchstatuses() {
      syncHandshakeTimeout()
      return { ok: true, ...loadHotspotFeed() }
    },
    async runhotspotsearchtick() {
      const result = await hotspotTick()
      return { ok: true, ...result }
    },
    reportsharedsessionlogin(body) {
      const now = nowMs()
      const conclusive = body.conclusive === true
      if (!conclusive) {
        return { ok: true, success: true, conclusive: false, gate: resolveLoginGate() }
      }
      const nickname = clampStr(body.nickname ?? '', 60)
      const xhsId = clampStr(body.xhsId ?? '', 60)
      const homepage = clampStr(body.homepage ?? '', 1000)
      const message = clampStr(body.message ?? '', 500)
      if (body.loggedIn === true) {
        // 共用会话登录确认：按 xhsId 归属到已有账号（无则新建占位记录）。
        let target =
          xhsId !== ''
            ? store.listAccounts().find((r) => r.xhs_id !== '' && r.xhs_id === xhsId)
            : undefined
        if (!target && nickname) {
          target = store.upsertAccount({
            nickname,
            xhs_id: xhsId,
            homepage,
            note: '',
            monitored: store.listAccounts().length === 0 ? 1 : 0,
            fetch_status: 'idle',
            fetch_message: LOGIN_GATE_MESSAGE,
            login_status: 'verified',
          })
        }
        if (!target) {
          return {
            ok: true,
            success: false,
            message: '共用会话登录确认未带账号昵称，无法回写。',
            gate: resolveLoginGate(),
          }
        }
        if (nickname) store.updateAccount(target.id, { nickname })
        if (xhsId) store.updateAccount(target.id, { xhs_id: xhsId })
        if (homepage) store.updateAccount(target.id, { homepage })
        store.writeGate(target.id, {
          gate_state: 'valid',
          gate_last_verified_at: now,
          gate_last_handshake_at: now,
          gate_handshake_status: 'valid',
          gate_browser_state: 'logged_in',
          gate_handshake_message: '共用会话确认已登录小红书。',
          gate_shared_state: 'logged_in',
          gate_shared_at: now,
          gate_shared_message: message || '共用会话确认已登录小红书。',
          gate_shared_nickname: nickname || target.nickname,
        })
        store.fulfillSharedRequests('account_info', { accountId: target.id }, '共用会话已确认登录小红书。')
        return {
          ok: true,
          success: true,
          conclusive: true,
          accountId: target.id,
          gate: resolveLoginGate(),
          message: `已确认共用会话登录小红书（${nickname || target.nickname}）。`,
        }
      }
      // conclusive 登出：只在无更新的任务通道确认时才写 expired
      // （Muse 的 taskFresher 规则）。
      const gate = resolveLoginGate()
      const gateAccount = gate.accountId != null ? store.getAccount(gate.accountId) : null
      const taskFresher =
        gateAccount != null &&
        gateAccount.gate_last_verified_at != null &&
        gateAccount.gate_last_verified_at > now - 24 * 3600 * 1000
      if (taskFresher) {
        return {
          ok: true,
          success: true,
          conclusive: true,
          gate: resolveLoginGate(),
          message: '共用会话登出确认被更新的任务通道确认覆盖，登录态保持已登录。',
        }
      }
      if (gateAccount) {
        store.writeGate(gateAccount.id, {
          gate_state: 'expired',
          gate_handshake_status: 'expired',
          gate_browser_state: 'logged_out',
          gate_handshake_message: message || '共用会话确认小红书已登出。',
          gate_shared_state: 'logged_out',
          gate_shared_at: now,
          gate_shared_message: message || '共用会话确认小红书已登出。',
        })
      }
      return {
        ok: true,
        success: true,
        conclusive: true,
        gate: resolveLoginGate(),
        message: '已确认共用会话登出小红书，请重新扫码登录。',
      }
    },
    listsharedsessionrequests() {
      const { requests, pendingCount } = store.listSharedSessionRequests()
      return {
        ok: true,
        requests: requests.map(sharedSessionRequestRow),
        pendingCount,
      }
    },
    requestviasharedsession(body) {
      const kind = clampStr(body.kind ?? '', 60)
      // 清单 §1 #80 与 §2.16 只有 8 种 kind：Muse actions.ts 的 requestViaSharedSession
      //（z.enum([...8 种...])）与 fulfillSharedRequests 里均无 'x_login'，
      // 全仓 grep 也无任何 'x_login' 共用会话请求——'x_login' 是 DSH 侧多出来的，
      // 已删（store.mjs 的 SHARED_KINDS 与 savexloginresult 里的 dead fulfill 一并删）。
      const validKinds = [
        'account_info',
        'account_notes',
        'note_images',
        'note_details',
        'monitored_account',
        'lead_dm',
        'hotspot_xhs',
        'publish_note',
      ]
      if (!validKinds.includes(kind)) {
        return {
          ok: false,
          requestId: 0,
          message: `不支持的共用会话请求类型：${kind || '（空）'}。`,
          gate: resolveLoginGate(),
        }
      }
      const gate = resolveLoginGate()
      if (kind !== 'account_info' && !gate.canFetch) {
        return {
          ok: false,
          requestId: 0,
          message: `还没有登录，先登录再登记这项工作：${gate.message}`,
          gate: resolveLoginGate(),
        }
      }
      let accountId = body.accountId ?? null
      if (accountId == null && kind !== 'monitored_account' && kind !== 'publish_note') {
        accountId = gate.accountId
      }
      const message = clampStr(body.message ?? '', 500)
      // store.upsertSharedRequest 返回的是数字 id（新建或已存在 pending 行的 id），
      // 直接当 requestId 返回，不要把它当行传给 sharedSessionRequestRow。
      const requestId = store.upsertSharedRequest(kind, {
        accountId,
        monitoredAccountId: body.monitoredAccountId ?? null,
        noteId: body.noteId ?? null,
        message:
          message ||
          (kind === 'account_info'
            ? '共用登录请求：请在 Muse 聊天里让 Muse 在你能看到的浏览器里打开小红书（需要时扫码登录），确认登录后工作台会认这个共用会话。'
            : undefined),
      })
      return {
        ok: true,
        requestId,
        message:
          kind === 'account_info'
            ? '已登记共用登录请求：回到 Muse 聊天里说一声，Muse 会在你能看到的浏览器里打开小红书登录页供你扫码；登录确认后会自动回写到工作台，门禁会变成已登录（共用会话）。'
            : '已登记到共用会话请求清单：回到 Muse 聊天里说一声，Muse 会用已登录的那个浏览器完成并写回。',
        gate: resolveLoginGate(),
      }
    },
    cancelsharedsessionrequest(body) {
      store.cancelSharedSessionRequest(body.id)
      return { ok: true, message: '已取消该共用会话请求。' }
    },

    // ---- 刷新与状态同步 ----
    refreshalldata() {
      const gate = resolveLoginGate()
      const accountsCount = store.listAccounts().length
      const monitoredCount = store.listMonitoredAccounts().length
      if (!gate.canFetch) {
        // 未登录：needsLogin=true，并自动唤起一次扫码
        // （DSH：给出登录页入口 + 登记 account_info 请求）。
        const primary =
          gate.accountId != null
            ? store.getAccount(gate.accountId)
            : store.listAccounts()[0] ?? null
        if (primary) {
          store.writeGate(primary.id, { gate_qr_last_opened_at: nowMs() })
          store.upsertSharedRequest('account_info', {
            accountId: primary.id,
            message:
              '刷新全部数据时发现未登录：请在 Muse 聊天里让 Muse 在你能看到的浏览器里打开小红书登录页扫码，确认登录后由 Muse 回写共用会话状态。',
          })
        }
        return {
          ok: true,
          needsLogin: true,
          started: { infoFetches: 0, noteFetches: 0, monitoredFetches: 0 },
          accountsCount,
          monitoredCount,
          loginUrl: XHS_LOGIN_URL,
          message: `需要先登录小红书：${gate.message}已给出登录页入口（点链接在浏览器里打开扫码），或在 Muse 聊天里让 Muse 在你能看到的浏览器里打开登录页。`,
        }
      }
      // 已登录：共用会话通道下登记各管线请求（由已登录浏览器侧处理并回写），
      // 并如实报告 sharedPending；无桥时只做门禁判断 + 计数返回。
      const sharedActive = sharedChannelActive(gate)
      let sharedPending = 0
      let infoFetches = 0
      let noteFetches = 0
      let monitoredFetches = 0
      if (sharedActive) {
        const primary =
          gate.accountId != null
            ? store.getAccount(gate.accountId)
            : store.listAccounts()[0] ?? null
        if (primary) {
          store.upsertSharedRequest('account_info', { accountId: primary.id })
          store.upsertSharedRequest('account_notes', { accountId: primary.id })
          infoFetches = 1
          noteFetches = 1
        }
        for (const m of store.listMonitoredAccounts()) {
          store.upsertSharedRequest('monitored_account', { monitoredAccountId: m.id })
          monitoredFetches += 1
        }
        sharedPending = store.countPendingSharedRequests()
      }
      // 并检查一次私信（无桥时只留状态）。
      const leadRes = startLeadDmCheckTask()
      return {
        ok: true,
        needsLogin: false,
        started: { infoFetches, noteFetches, monitoredFetches },
        sharedPending,
        sharedActive,
        accountsCount,
        monitoredCount,
        message: sharedActive
          ? `已登记 ${infoFetches + noteFetches + monitoredFetches} 个共用会话请求（账号信息、笔记、监测账号），待在已登录的浏览器里处理；私信检查：${leadRes.message}`
          : `浏览器扩展未配对，暂未开始任何拉取；已确认绑定账号 ${accountsCount} 个、监测账号 ${monitoredCount} 个，配对扩展后可重新刷新。私信检查：${leadRes.message}`,
      }
    },
    syncfetchstatuses() {
      syncInfoFetchTimeout()
      syncHandshakeTimeout()
      return {
        ok: true,
        accounts: store.listAccounts().map((a) => ({
          id: a.id,
          nickname: a.nickname,
          fetchStatus: a.fetch_status,
          fetchMessage: a.fetch_message,
          fetchedCount: store.countFetchedNotes(a.id),
          fetchedAt: toIso(a.fetched_at),
        })),
      }
    },
    syncloggedininfostatuses() {
      syncInfoFetchTimeout()
      return {
        ok: true,
        accounts: store.listAccounts().map((a) => ({
          id: a.id,
          nickname: a.nickname,
          infoFetchStatus: a.info_fetch_status,
          infoFetchMessage: a.info_fetch_message,
        })),
      }
    },
    syncloginstatuses() {
      syncHandshakeTimeout()
      return {
        ok: true,
        accounts: store.listAccounts().map((a) => ({
          id: a.id,
          nickname: a.nickname,
          loginStatus: a.login_status,
          loginVerifiedAt: toIso(a.login_verified_at),
          loginMessage: a.login_message,
        })),
        gate: resolveLoginGate(),
      }
    },
    syncmonitoredfetchstatuses() {
      return {
        ok: true,
        monitoredAccounts: store.listMonitoredAccounts().map((a) => ({
          id: a.id,
          nickname: a.nickname,
          homepage: a.homepage,
          fetchStatus: a.fetch_status,
          fetchMessage: a.fetch_message,
          fetchedCount: store.countMonitoredNotes(a.id),
          fetchedAt: toIso(a.fetched_at),
        })),
      }
    },
    syncnoteimagefetchstatuses() {
      syncInfoFetchTimeout()
      return {
        ok: true,
        accounts: store.listAccounts().map((a) => ({
          id: a.id,
          nickname: a.nickname,
          imageFetchStatus: a.image_fetch_status,
          imageFetchMessage: a.image_fetch_message,
        })),
      }
    },
  }

  // 83 个动作名（小写）必须全部注册，缺一不可。
  const actionNames = [
    'addmonitoredaccount',
    'bindaccount',
    'cancelsharedsessionrequest',
    'checkxloginstatus',
    'cleanupunverifiedfetchednotes',
    'confirmqrscanned',
    'createnote',
    'deleteaccount',
    'deleteasset',
    'deletemonitoredaccount',
    'deletenote',
    'generateimage',
    'generatenote',
    'gethotspotfeed',
    'getimagegensettings',
    'getleadmonitor',
    'getlogingate',
    'getonboardingstate',
    'getsettings',
    'getstate',
    'handshakeloginsession',
    'importasset',
    'listaccounts',
    'listassets',
    'listcompetitornotifications',
    'listfetchednotes',
    'listleadnotifications',
    'listmonitoredaccounts',
    'listmonitorednotes',
    'listmonitoredsnapshots',
    'listnotes',
    'listsharedsessionrequests',
    'listsnapshots',
    'markallcompetitornotificationsread',
    'markallleadnotificationsread',
    'markcompetitornotificationread',
    'markleadnotificationread',
    'publishnote',
    'recordmetrics',
    'refreshalldata',
    'reportsharedsessionlogin',
    'requestqrlogin',
    'requestviasharedsession',
    'runhotspotsearchtick',
    'saveboundloggedinaccount',
    'savefetchednotes',
    'savehandshakeresult',
    'savehotspotitems',
    'saveleaddmcheck',
    'saveloggedinaccountinfo',
    'saveloginverification',
    'savemonitoredaccountfetch',
    'savenoteimages',
    'savenotedetails',
    'savexlogincheckresult',
    'savexloginresult',
    'setmonitoredaccount',
    'startbackfillnotedetails',
    'startbackfillnoteimages',
    'startbindloggedinaccount',
    'startfetchaccountnotes',
    'startfetchloggedininfo',
    'startfetchmonitoredaccount',
    'startfirstuselogin',
    'starthotspotsearch',
    'startleaddmcheck',
    'startverifylogin',
    'startxlogin',
    'syncfetchstatuses',
    'synchotspotsearchstatuses',
    'syncloggedininfostatuses',
    'syncloginstatuses',
    'syncleaddmstatuses',
    'syncmonitoredfetchstatuses',
    'syncnotedetailfetchstatuses',
    'syncnoteimagefetchstatuses',
    'testimagegenapi',
    'unpublishnote',
    'updateaccount',
    'updatehotspotconfig',
    'updateimagegensettings',
    'updatenote',
    'updatesettings',
  ]
  for (const actionName of actionNames) {
    const handler = actions[actionName]
    if (typeof handler !== 'function') {
      throw new Error(`小红书运营工作台启动失败：动作 ${actionName} 未实现。`)
    }
    registerRoute('POST', `${PREFIX}/${actionName}`, async (req) => {
      try {
        const body = await parseBody(req)
        const result = await handler(body ?? {}, req)
        return jsonResponse(result ?? { ok: true })
      } catch (error) {
        console.error(`[xiaohongshu-ops] ${actionName} 失败:`, error)
        return jsonResponse({ ok: false, message: '操作失败，请稍后重试。' })
      }
    })
  }

  // GET 素材图片二进制：/api/xiaohongshu-ops/assets/:id/content
  registerRoute('GET', `${PREFIX}/assets/:id/content`, async (req) => {
    try {
      const rawUrl = req?.request?.url ?? req?.url ?? req?.pathname ?? ''
      const paramsId = req?.params?.id ?? req?.request?.params?.id
      const match = String(rawUrl).match(/\/assets\/(\d+)\/content/)
      const id = Number(paramsId ?? (match ? match[1] : NaN))
      if (!Number.isFinite(id)) {
        return jsonResponse({ ok: false, message: '素材编号无效。' }, 400)
      }
      const asset = store.getAsset(id)
      if (!asset) return jsonResponse({ ok: false, message: '素材不存在。' }, 404)
      const buffer = store.readBlobFile(asset.blob_key)
      if (!buffer) return jsonResponse({ ok: false, message: '图片文件不存在。' }, 404)
      return new Response(buffer, {
        status: 200,
        headers: {
          'content-type': asset.mime_type || 'image/jpeg',
          'cache-control': 'public, max-age=86400',
        },
      })
    } catch (error) {
      console.error('[xiaohongshu-ops] 读取素材失败:', error)
      return jsonResponse({ ok: false, message: '读取图片失败，请稍后重试。' }, 500)
    }
  })
}
