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

// ---- 行映射：snake_case 存储行 -> camelCase 接口行 ----
function accountRow(row) {
  if (!row) return null
  return {
    id: row.id,
    nickname: row.nickname,
    xhsId: row.xhs_id,
    homepage: row.homepage,
    avatarUrl: row.avatar_url || row.avatar_source_url || null,
    avatarSourceUrl: row.avatar_source_url || '',
    followersCount: row.followers_count,
    followingCount: row.following_count,
    likesCollectsCount: row.likes_collects_count,
    note: row.note,
    monitored: Boolean(row.monitored),
    loginStatus: row.login_status,
    loginVerifiedAt: row.login_verified_at,
    loginMessage: row.login_message,
    fetchStatus: row.fetch_status,
    fetchMessage: row.fetch_message,
    fetchedCount: row.fetched_count,
    fetchedAt: row.fetched_at,
    infoFetchStatus: row.info_fetch_status,
    infoFetchMessage: row.info_fetch_message,
    imageFetchStatus: row.image_fetch_status,
    imageFetchMessage: row.image_fetch_message,
    createdAt: row.created_at,
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
    images: parseJsonArray(row.images_json),
    fetchedAt: row.fetched_at,
    createdAt: row.created_at,
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
    createdAt: row.created_at,
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
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    recordedAt: row.recorded_at,
    capturedAt: row.captured_at,
  }
}

function monitoredAccountRow(row) {
  if (!row) return null
  return {
    id: row.id,
    nickname: row.nickname,
    xhsId: row.xhs_id,
    homepage: row.homepage,
    avatarUrl: row.avatar_url || row.avatar_source_url || null,
    avatarSourceUrl: row.avatar_source_url || '',
    followersCount: row.followers_count,
    followingCount: row.following_count,
    likesCollectsCount: row.likes_collects_count,
    note: row.note,
    fetchStatus: row.fetch_status,
    fetchMessage: row.fetch_message,
    fetchedCount: row.fetched_count,
    fetchedAt: row.fetched_at,
    createdAt: row.created_at,
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
    fetchedAt: row.fetched_at,
    createdAt: row.created_at,
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
    recordedAt: row.recorded_at,
    capturedAt: row.captured_at,
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
  const dueHandshake = core.dueHandshake
  const nowIso = core.nowIso
  const nowMs = core.nowMs
  const HANDSHAKE_INTERVAL_MS = core.HANDSHAKE_INTERVAL_MS

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
  function applyConclusiveLoggedIn(info = {}) {
    const now = nowMs()
    const iso = nowIso()
    let account = null
    if (info.xhsId) account = store.getAccountByXhsId(info.xhsId)
    if (!account && info.nickname) {
      account = store.listAccounts().find((a) => a.nickname === info.nickname) ?? null
    }
    if (account) {
      const patch = {
        login_status: 'verified',
        login_verified_at: iso,
        login_message: '',
        info_fetch_status: 'done',
        info_fetch_message: '',
      }
      if (info.nickname) patch.nickname = info.nickname
      if (info.xhsId) patch.xhs_id = info.xhsId
      if (info.homepage) patch.homepage = info.homepage
      store.updateAccount(account.id, patch)
    }
    store.updateLoginSession({
      account_id: account?.id ?? store.getLoginSession().account_id,
      gate_state: 'valid',
      browser_state: 'logged_in',
      handshake_status: 'valid',
      handshake_message: '',
      last_handshake_at: now,
      last_verified_at: now,
      qr_auto_opened_at: null,
    })
    return account
  }

  function applyConclusiveLoggedOut() {
    const now = nowMs()
    const prev = store.getLoginSession()
    const wasValid = prev.gate_state === 'valid'
    // 仅在 valid→expired 跃迁且本轮未自动开过二维码时，自动唤起一次扫码登录。
    const qrAutoOpened = wasValid && !prev.qr_auto_opened_at
    const patch = {
      browser_state: 'logged_out',
      handshake_status: 'expired',
      handshake_message: '浏览器确认已登出。',
      last_handshake_at: now,
      gate_state: 'expired',
    }
    if (qrAutoOpened) {
      patch.qr_auto_opened_at = now
      patch.qr_last_opened_at = now
    }
    store.updateLoginSession(patch)
    return { qrAutoOpened }
  }

  // ---- 握手 tick：每 60 秒一次，防重叠 ----
  let tickRunning = false
  async function handshakeTick() {
    if (tickRunning) {
      return {
        ok: true,
        skipped: true,
        gate: resolveLoginGate(store),
        message: '上一次握手还在进行，本次跳过。',
      }
    }
    const session = store.getLoginSession()
    if (!dueHandshake(session.last_handshake_at)) {
      return {
        ok: true,
        skipped: true,
        gate: resolveLoginGate(store),
        message: '距离上次握手不足 60 秒，本次跳过。',
      }
    }
    tickRunning = true
    try {
      const bridgeStatus = bridge.getBridgeStatus()
      if (!bridgeStatus.paired) {
        // 无桥接：记 inconclusive，绝不误报掉登录，绝不改变门禁。
        store.updateLoginSession({
          handshake_status: 'unknown',
          handshake_message: '浏览器扩展未配对，无法确认登录状态；登录门禁未改变。',
          last_handshake_at: nowMs(),
        })
        return {
          ok: true,
          conclusive: false,
          gate: resolveLoginGate(store),
          message: '浏览器扩展未配对，握手结果无法确定，登录状态未改变。',
        }
      }
      const result = await bridge.run({ kind: 'checkLogin' })
      if (!result || result.conclusive !== true) {
        store.updateLoginSession({
          handshake_status: 'unknown',
          handshake_message: '握手结果无法确定，未改变登录门禁。',
          last_handshake_at: nowMs(),
        })
        return {
          ok: true,
          conclusive: false,
          gate: resolveLoginGate(store),
          message: '握手结果无法确定，登录状态未改变。',
        }
      }
      if (result.loggedIn) {
        applyConclusiveLoggedIn(result)
        return {
          ok: true,
          conclusive: true,
          gate: resolveLoginGate(store),
          message: '握手确认已登录。',
        }
      }
      const { qrAutoOpened } = applyConclusiveLoggedOut()
      return {
        ok: true,
        conclusive: true,
        gate: resolveLoginGate(store),
        message: qrAutoOpened
          ? '握手确认已登出，已自动唤起一次扫码登录。'
          : '握手确认已登出，请重新扫码登录。',
      }
    } finally {
      tickRunning = false
    }
  }

  const timer = core.clock.setInterval(() => {
    handshakeTick().catch(() => {
      // 握手失败不抛到宿主，只记 inconclusive；下次定时再试。
    })
  }, HANDSHAKE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  const dispose = () => {
    core.clock.clearInterval(timer)
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
    const gate = resolveLoginGate(store)
    if (gate.canFetch) return null
    return {
      ok: true,
      success: false,
      discarded: true,
      message: `登录门禁未通过（${gate.message}），本次结果已丢弃，未写入。`,
      gate,
    }
  }

  function recordNoteSnapshots(savedNotes) {
    for (const note of savedNotes) {
      if (
        note.likes != null ||
        note.collects != null ||
        note.comments != null ||
        note.shares != null
      ) {
        store.recordSnapshot(note.id, {
          likes: note.likes ?? 0,
          collects: note.collects ?? 0,
          shares: note.shares ?? 0,
          comments: note.comments ?? 0,
        })
      }
    }
  }

  function recordMonitoredNoteSnapshots(savedNotes) {
    for (const note of savedNotes) {
      if (
        note.likes != null ||
        note.collects != null ||
        note.comments != null ||
        note.shares != null
      ) {
        store.recordMonitoredSnapshot(note.id, {
          likes: note.likes ?? 0,
          collects: note.collects ?? 0,
          shares: note.shares ?? 0,
          comments: note.comments ?? 0,
        })
      }
    }
  }

  // 已拉笔记镜像进笔记库（source='fetched'，状态 published），与 Muse 一致：
  // Muse 的笔记库里 20 篇已拉笔记 + 草稿都在 notes 表里，saveFetchedNotes 只写
  // fetched_notes 的话，笔记库就看不到已拉笔记。
  function syncFetchedNoteMirrors(accountId, savedFetchedNotes) {
    for (const fn of savedFetchedNotes ?? []) {
      const existing = store.listNotes().find(
        (n) =>
          n.source === 'fetched' &&
          n.account_id === accountId &&
          (fn.url ? n.source_url === fn.url : fn.title && n.title === fn.title),
      )
      const patch = {
        title: fn.title ?? '',
        body: fn.excerpt ?? '',
        fetched_images_json: fn.images_json ?? '[]',
      }
      if (existing) {
        store.updateNote(existing.id, patch)
      } else {
        store.createNote({
          account_id: accountId,
          title: fn.title ?? '',
          body: fn.excerpt ?? '',
          tags_json: '[]',
          topic: '',
          status: 'published',
          image_ids_json: '[]',
          image_captions_json: '[]',
          fetched_images_json: fn.images_json ?? '[]',
          source: 'fetched',
          source_url: fn.url ?? '',
          published_at: null,
        })
      }
    }
  }

  // ================= 49 个动作（48 个 Muse 动作 + getstate 聚合端点） =================
  const actions = {
    // ---- 设置 ----
    getsettings() {
      const settings = store.getSettings()
      return {
        ok: true,
        settings: {
          dataDirLabel: settings.data_dir_label,
          updatedAt: settings.updated_at,
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
        settings: { dataDirLabel: settings.data_dir_label, updatedAt: settings.updated_at },
        message: '设置已保存。',
      }
    },

    // ---- 绑定 / 主账号 ----
    listaccounts() {
      return { ok: true, accounts: store.listAccounts().map(accountRow) }
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
      return notStarted(bridgeNotPairedMessage('读取登录账号信息'))
    },
    startverifylogin(body) {
      const account = store.getAccount(body.accountId)
      if (!account) return { ok: false, message: '账号不存在。' }
      return notStarted(bridgeNotPairedMessage('验证登录状态'))
    },
    startfetchaccountnotes(body) {
      const account = store.getAccount(body.accountId)
      if (!account) return { ok: false, message: '账号不存在。' }
      const gate = resolveLoginGate(store)
      if (!gate.canFetch) {
        return notStarted(`登录门禁未通过：${gate.message}`)
      }
      return notStarted(bridgeNotPairedMessage('拉取账号笔记'))
    },
    startbackfillnoteimages(body) {
      if (body.accountId != null && !store.getAccount(body.accountId)) {
        return { ok: false, message: '账号不存在。' }
      }
      const gate = resolveLoginGate(store)
      if (!gate.canFetch) {
        return notStarted(`登录门禁未通过：${gate.message}`)
      }
      return notStarted(bridgeNotPairedMessage('补拉笔记配图'))
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
      return { ok: true, account: accountRow(updated), message: '账号备注已保存。' }
    },

    // ---- 登录门禁 / 握手 ----
    getlogingate() {
      return { ok: true, gate: resolveLoginGate(store) }
    },

    // ---- 聚合状态（客户端 loadAll / reloadNotes 唯一入口） ----
    // 一次返回全部页面状态，并把服务端字段归一化成客户端组件直接读的形状：
    // 账号补 xiaohongshuId/profileUrl/following/followers/likesAndCollects；
    // 笔记补 url/coverUrl/images/imageNotes/指标/accountNickname/accountXhsId；
    // 监测账号附带 notes（含 snapshots）与同名字段别名；
    // loginGate 补 status（'verified'）/verified/verifiedAt/at；
    // handshake 补 status（'verified'/'failed'/'unknown'）/at/message/ok/browserState。
    getstate() {
      const gate = resolveLoginGate(store)
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
          fetchedAt = fetched.fetched_at
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
        const base = monitoredAccountRow(row)
        const notes = store.listMonitoredNotes(row.id).map((n) => {
          const nb = monitoredNoteRow(n)
          const snapshots = store.listMonitoredSnapshots(n.id).map((s) => ({
            at: s.recorded_at,
            likes: s.likes,
            collects: s.collects,
            shares: s.shares,
            comments: s.comments,
          }))
          return { ...nb, snapshots }
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

      return {
        ok: true,
        accounts: accounts.map((a) => {
          const r = accountRow(a)
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
      }
    },
    async handshakeloginsession() {
      const result = await handshakeTick()
      return { ok: true, ...result }
    },
    requestqrlogin() {
      store.updateLoginSession({ qr_last_opened_at: nowMs() })
      return {
        ok: true,
        url: XHS_LOGIN_URL,
        loginUrl: XHS_LOGIN_URL,
        message:
          '请在浏览器中打开上方链接，使用小红书 App 扫码登录；登录成功后工作台会自动读取登录账号信息。',
      }
    },
    savehandshakeresult(body) {
      const conclusive = body.conclusive === true
      const browserLoggedIn = body.browserLoggedIn === true
      const message = clampStr(body.message ?? '', 500)
      if (!conclusive) {
        // inconclusive 握手绝不改变门禁。
        store.updateLoginSession({
          handshake_status: 'unknown',
          handshake_message: message || '握手结果无法确定，未改变登录门禁。',
          last_handshake_at: nowMs(),
        })
        return {
          ok: true,
          success: true,
          conclusive: false,
          gate: resolveLoginGate(store),
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
          gate: resolveLoginGate(store),
          message: '已确认登录小红书。',
        }
      }
      const { qrAutoOpened } = applyConclusiveLoggedOut()
      return {
        ok: true,
        success: true,
        conclusive: true,
        gate: resolveLoginGate(store),
        message: qrAutoOpened
          ? '已确认登出，已自动唤起一次扫码登录。'
          : '已确认登出，请重新扫码登录。',
      }
    },
    saveloginverification(body) {
      const account = store.getAccount(body.accountId)
      if (!account) return { ok: true, success: false, message: '账号不存在，本次验证结果未写入。' }
      const now = nowIso()
      if (body.verified !== true) {
        store.updateAccount(body.accountId, {
          login_status: 'failed',
          login_message: clampStr(body.message ?? '', 500) || '登录验证未通过。',
        })
        return { ok: true, success: false, message: '登录验证未通过。' }
      }
      store.updateAccount(body.accountId, {
        nickname: clampStr(body.nickname ?? '', 60) || account.nickname,
        xhs_id: clampStr(body.xhsId ?? '', 60) || account.xhs_id,
        homepage: clampStr(body.homepage ?? '', 1000) || account.homepage,
        following_count: intOrNull(body.followingCount) ?? account.following_count,
        followers_count: intOrNull(body.followersCount) ?? account.followers_count,
        likes_collects_count:
          intOrNull(body.likesCollectsCount) ?? account.likes_collects_count,
        avatar_url: clampStr(body.avatarUrl ?? '', 2000) || account.avatar_url,
        avatar_source_url: clampStr(body.avatarUrl ?? '', 2000) || account.avatar_source_url,
        login_status: 'verified',
        login_verified_at: now,
        login_message: '',
        info_fetch_status: 'done',
        info_fetch_message: '',
      })
      store.updateLoginSession({
        account_id: body.accountId,
        gate_state: 'valid',
        browser_state: 'logged_in',
        last_verified_at: nowMs(),
        qr_auto_opened_at: null,
      })
      return {
        ok: true,
        success: true,
        account: accountRow(store.getAccount(body.accountId)),
        gate: resolveLoginGate(store),
        message: '登录验证通过，已保存账号信息。',
      }
    },
    saveloggedinaccountinfo(body) {
      if (body.success !== true) {
        const account = store.getAccount(body.accountId)
        if (account) {
          store.updateAccount(body.accountId, {
            info_fetch_status: 'failed',
            info_fetch_message: clampStr(body.message ?? '', 500) || '读取账号信息失败。',
          })
        }
        return {
          ok: true,
          success: false,
          message: clampStr(body.message ?? '', 500) || '读取账号信息失败。',
        }
      }
      const now = nowIso()
      const account = store.upsertAccount({
        id: body.accountId ?? undefined,
        nickname: clampStr(body.nickname ?? '', 60),
        xhs_id: clampStr(body.xhsId ?? '', 60),
        homepage: clampStr(body.homepage ?? '', 1000),
        following_count: intOrNull(body.followingCount),
        followers_count: intOrNull(body.followersCount),
        likes_collects_count: intOrNull(body.likesCollectsCount),
        avatar_url: clampStr(body.avatarUrl ?? '', 2000),
        avatar_source_url: clampStr(body.avatarUrl ?? '', 2000),
        login_status: 'verified',
        login_verified_at: now,
        login_message: '',
        info_fetch_status: 'done',
        info_fetch_message: '',
      })
      store.updateLoginSession({
        account_id: account.id,
        gate_state: 'valid',
        browser_state: 'logged_in',
        last_verified_at: nowMs(),
        qr_auto_opened_at: null,
      })
      return {
        ok: true,
        success: true,
        account: accountRow(account),
        gate: resolveLoginGate(store),
        message: '已保存登录账号信息。',
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
      const now = nowIso()
      const account = store.upsertAccount({
        nickname: clampStr(body.nickname ?? '', 60),
        xhs_id: clampStr(body.xhsId ?? '', 60),
        homepage: clampStr(body.homepage ?? '', 1000),
        following_count: intOrNull(body.followingCount),
        followers_count: intOrNull(body.followersCount),
        likes_collects_count: intOrNull(body.likesCollectsCount),
        avatar_url: clampStr(body.avatarUrl ?? '', 2000),
        avatar_source_url: clampStr(body.avatarUrl ?? '', 2000),
        login_status: 'verified',
        login_verified_at: now,
        login_message: '',
        info_fetch_status: 'done',
        info_fetch_message: '',
      })
      store.updateLoginSession({
        account_id: account.id,
        gate_state: 'valid',
        browser_state: 'logged_in',
        last_verified_at: nowMs(),
        qr_auto_opened_at: null,
      })
      return {
        ok: true,
        success: true,
        account: accountRow(account),
        gate: resolveLoginGate(store),
        message: '已绑定登录账号。',
      }
    },

    // ---- 已拉取笔记 ----
    listfetchednotes(body) {
      const accountId = body.accountId ?? null
      return {
        ok: true,
        fetchedNotes: store.listFetchedNotes(accountId).map(fetchedNoteRow),
      }
    },
    savefetchednotes(body) {
      const blocked = gateBlockedResult()
      if (blocked) return blocked
      const account = store.getAccount(body.accountId)
      if (!account) {
        return { ok: true, success: false, message: '账号不存在，本次拉取结果已丢弃，未写入。' }
      }
      const notes = Array.isArray(body.notes) ? body.notes.slice(0, 20) : []
      const result = store.upsertFetchedNotes(body.accountId, notes)
      if (body.ownerNickname || body.ownerXhsId) {
        store.updateAccount(body.accountId, {
          nickname: clampStr(body.ownerNickname ?? '', 60) || account.nickname,
          xhs_id: clampStr(body.ownerXhsId ?? '', 60) || account.xhs_id,
        })
      }
      store.updateAccount(body.accountId, {
        fetch_status: 'done',
        fetch_message: clampStr(body.message ?? '', 500),
        fetched_count: store.listFetchedNotes(body.accountId).length,
        fetched_at: nowIso(),
      })
      recordNoteSnapshots(result.saved)
      syncFetchedNoteMirrors(body.accountId, result.saved)
      return {
        ok: true,
        success: true,
        saved: result.total,
        inserted: result.inserted,
        updated: result.updated,
        message: `已保存 ${result.total} 篇笔记。`,
      }
    },
    cleanupunverifiedfetchednotes() {
      const deleted = store.cleanupUnverifiedFetchedNotes()
      // 同步删除未验证账号在笔记库里的已拉笔记镜像。
      const verifiedIds = new Set(
        store.listAccounts().filter((a) => a.login_status === 'verified').map((a) => a.id),
      )
      for (const note of store.listNotes()) {
        if (
          note.source === 'fetched' &&
          note.account_id != null &&
          !verifiedIds.has(note.account_id)
        ) {
          store.deleteNote(note.id)
        }
      }
      return { ok: true, deleted, message: `已清理 ${deleted} 篇未验证账号的笔记。` }
    },
    savenoteimages(body) {
      const blocked = gateBlockedResult()
      if (blocked) return blocked
      const account = store.getAccount(body.accountId)
      if (!account) {
        return { ok: true, success: false, message: '账号不存在，本次配图结果未写入。' }
      }
      if (body.success !== true) {
        store.updateAccount(body.accountId, {
          image_fetch_status: 'failed',
          image_fetch_message: clampStr(body.message ?? '', 500) || '读取笔记配图失败。',
        })
        return {
          ok: true,
          success: false,
          message: clampStr(body.message ?? '', 500) || '读取笔记配图失败。',
        }
      }
      const updated = store.saveNoteImages(
        body.accountId,
        Array.isArray(body.items) ? body.items.slice(0, 20) : [],
      )
      // 配图回填后同步笔记库镜像的 fetched_images_json。
      syncFetchedNoteMirrors(body.accountId, store.listFetchedNotes(body.accountId))
      store.updateAccount(body.accountId, {
        image_fetch_status: 'done',
        image_fetch_message: clampStr(body.message ?? '', 500),
      })
      return { ok: true, success: true, updated, message: `已写回 ${updated} 篇笔记的配图。` }
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
      return { ok: true, note: noteRow(note), message: '已创建空白草稿。' }
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
        published_at: nowIso(),
      })
      return { ok: true, note: noteRow(updated), message: '笔记已标记为已发布。' }
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
        monitoredAccounts: store.listMonitoredAccounts().map(monitoredAccountRow),
      }
    },
    addmonitoredaccount(body) {
      const homepage = clampStr(body.homepage ?? '', 1000).trim()
      const match = homepage.match(/xiaohongshu\.com\/user\/profile\/([A-Za-z0-9_-]+)/)
      if (!homepage || !match) {
        return { ok: false, message: '请粘贴有效的小红书账号主页链接。' }
      }
      const xhsId = match[1]
      const existing =
        store.getMonitoredAccountByHomepage(homepage) ??
        store.listMonitoredAccounts().find((a) => a.xhs_id === xhsId)
      if (existing) {
        return {
          ok: true,
          exists: true,
          monitoredAccount: monitoredAccountRow(existing),
          message: '该监测账号已存在，无需重复添加。',
        }
      }
      const created = store.upsertMonitoredAccount({
        nickname: '',
        xhs_id: xhsId,
        homepage,
        fetch_status: 'idle',
      })
      return {
        ok: true,
        exists: false,
        monitoredAccount: monitoredAccountRow(created),
        message: '已添加监测账号，待拉取数据。',
      }
    },
    deletemonitoredaccount(body) {
      const account = store.getMonitoredAccount(body.id)
      if (!account) return { ok: false, message: '监测账号不存在。' }
      store.deleteMonitoredAccount(body.id)
      return { ok: true, message: '监测账号已删除。' }
    },
    setmonitoredaccount(body) {
      const account = store.getMonitoredAccount(body.id)
      if (!account) return { ok: false, message: '监测账号不存在。' }
      // 选择态由客户端持有（schema 未给监测账号设选中字段），服务端只校验并返回该账号。
      return {
        ok: true,
        monitoredAccount: monitoredAccountRow(account),
        message: '已切换到该监测账号。',
      }
    },
    startfetchmonitoredaccount(body) {
      const account = store.getMonitoredAccount(body.monitoredAccountId)
      if (!account) return { ok: false, message: '监测账号不存在。' }
      const gate = resolveLoginGate(store)
      if (!gate.canFetch) {
        return notStarted(`登录门禁未通过：${gate.message}`)
      }
      return notStarted(bridgeNotPairedMessage('拉取监测账号数据'))
    },
    savemonitoredaccountfetch(body) {
      const blocked = gateBlockedResult()
      if (blocked) return blocked
      const account = store.getMonitoredAccount(body.monitoredAccountId)
      if (!account) {
        return { ok: true, success: false, message: '监测账号不存在，本次结果未写入。' }
      }
      if (body.success !== true) {
        store.updateMonitoredAccount(body.monitoredAccountId, {
          fetch_status: 'failed',
          fetch_message: clampStr(body.message ?? '', 500) || '拉取监测账号失败。',
        })
        return {
          ok: true,
          success: false,
          message: clampStr(body.message ?? '', 500) || '拉取监测账号失败。',
        }
      }
      const now = nowIso()
      store.updateMonitoredAccount(body.monitoredAccountId, {
        nickname: clampStr(body.nickname ?? '', 60) || account.nickname,
        xhs_id: clampStr(body.xhsId ?? '', 60) || account.xhs_id,
        homepage: clampStr(body.homepage ?? '', 1000) || account.homepage,
        following_count: intOrNull(body.followingCount) ?? account.following_count,
        followers_count: intOrNull(body.followersCount) ?? account.followers_count,
        likes_collects_count:
          intOrNull(body.likesCollectsCount) ?? account.likes_collects_count,
        avatar_url: clampStr(body.avatarUrl ?? '', 2000) || account.avatar_url,
        avatar_source_url: clampStr(body.avatarUrl ?? '', 2000) || account.avatar_source_url,
        fetch_status: 'done',
        fetch_message: clampStr(body.message ?? '', 500),
        fetched_at: now,
      })
      const notes = Array.isArray(body.notes) ? body.notes.slice(0, 20) : []
      const result = store.upsertMonitoredNotes(body.monitoredAccountId, notes)
      store.updateMonitoredAccount(body.monitoredAccountId, {
        fetched_count: store.listMonitoredNotes(body.monitoredAccountId).length,
      })
      recordMonitoredNoteSnapshots(result.saved)
      return {
        ok: true,
        success: true,
        saved: result.total,
        inserted: result.inserted,
        updated: result.updated,
        monitoredAccount: monitoredAccountRow(store.getMonitoredAccount(body.monitoredAccountId)),
        message: `已保存监测账号的 ${result.total} 篇笔记。`,
      }
    },
    listmonitorednotes(body) {
      if (body.monitoredAccountId == null) {
        return { ok: false, message: '缺少监测账号编号。' }
      }
      return {
        ok: true,
        monitoredNotes: store
          .listMonitoredNotes(body.monitoredAccountId)
          .map(monitoredNoteRow),
      }
    },
    listmonitoredsnapshots(body) {
      if (body.monitoredNoteId == null) {
        return { ok: false, message: '缺少监测笔记编号。' }
      }
      return {
        ok: true,
        monitoredSnapshots: store
          .listMonitoredSnapshots(body.monitoredNoteId)
          .map(monitoredSnapshotRow),
      }
    },

    // ---- 刷新与状态同步 ----
    refreshalldata() {
      const gate = resolveLoginGate(store)
      const accountsCount = store.listAccounts().length
      const monitoredCount = store.listMonitoredAccounts().length
      if (!gate.canFetch) {
        return {
          ok: true,
          needsLogin: true,
          started: { infoFetches: 0, noteFetches: 0, monitoredFetches: 0 },
          accountsCount,
          monitoredCount,
          message: `需要先登录小红书：${gate.message}`,
        }
      }
      return {
        ok: true,
        needsLogin: false,
        started: { infoFetches: 0, noteFetches: 0, monitoredFetches: 0 },
        accountsCount,
        monitoredCount,
        message:
          '浏览器扩展未配对，暂未开始任何拉取；已确认绑定账号与监测账号数量，配对扩展后可重新刷新。',
      }
    },
    syncfetchstatuses() {
      return {
        ok: true,
        accounts: store.listAccounts().map((a) => ({
          id: a.id,
          nickname: a.nickname,
          fetchStatus: a.fetch_status,
          fetchMessage: a.fetch_message,
          fetchedCount: a.fetched_count,
          fetchedAt: a.fetched_at,
        })),
      }
    },
    syncloggedininfostatuses() {
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
      return {
        ok: true,
        accounts: store.listAccounts().map((a) => ({
          id: a.id,
          nickname: a.nickname,
          loginStatus: a.login_status,
          loginVerifiedAt: a.login_verified_at,
          loginMessage: a.login_message,
        })),
        gate: resolveLoginGate(store),
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
          fetchedCount: a.fetched_count,
          fetchedAt: a.fetched_at,
        })),
      }
    },
    syncnoteimagefetchstatuses() {
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

  // 49 个动作名（小写）必须全部注册，缺一不可。
  const actionNames = [
    'addmonitoredaccount',
    'bindaccount',
    'cleanupunverifiedfetchednotes',
    'createnote',
    'deleteaccount',
    'deleteasset',
    'deletemonitoredaccount',
    'deletenote',
    'generatenote',
    'getlogingate',
    'getsettings',
    'getstate',
    'handshakeloginsession',
    'importasset',
    'listaccounts',
    'listassets',
    'listfetchednotes',
    'listmonitoredaccounts',
    'listmonitorednotes',
    'listmonitoredsnapshots',
    'listnotes',
    'listsnapshots',
    'publishnote',
    'recordmetrics',
    'refreshalldata',
    'requestqrlogin',
    'saveboundloggedinaccount',
    'savefetchednotes',
    'savehandshakeresult',
    'saveloggedinaccountinfo',
    'saveloginverification',
    'savemonitoredaccountfetch',
    'savenoteimages',
    'setmonitoredaccount',
    'startbackfillnoteimages',
    'startbindloggedinaccount',
    'startfetchaccountnotes',
    'startfetchloggedininfo',
    'startfetchmonitoredaccount',
    'startverifylogin',
    'syncfetchstatuses',
    'syncloggedininfostatuses',
    'syncloginstatuses',
    'syncmonitoredfetchstatuses',
    'syncnoteimagefetchstatuses',
    'unpublishnote',
    'updateaccount',
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
