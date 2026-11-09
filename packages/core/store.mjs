// 本地存储的表逻辑：列定义、默认值、DDL、以及各表的读写方法。
// 不直接碰任何宿主能力：数据库访问一律走注入的 storage 接口，
// 时间一律走注入的 clock；SQLite / JSON 文件后端实现在宿主适配层
//（dsh/adapters.mjs 的 createNodeStorage）。
//
// storage 接口：
//   exec(sql)                          执行 DDL（JSON 后端可忽略）
//   all(table, where, orderBy)         查询多行
//   get(table, id)                     按 id 查询一行（无则 undefined）
//   insert(table, row)                 插入已补全默认值的行，返回保存后的行
//   update(table, id, patch)           更新一行，返回更新后的行（无则 null）
//   delete(table, id)
//   writeBlob(blobKey, buffer) / readBlob(blobKey) -> Buffer|null
//   deleteBlob(blobKey)
//   close()
// clock 接口：{ now() -> 毫秒时间戳, nowIso() -> ISO 文本 }
// logger 接口：{ info/warn/error(...args) }，可为空。
//
// 约定：列名用 snake_case；除 login_session 的 *_at（毫秒时间戳）外，
// 时间一律用 ISO 文本。指标 null 与 0 要区分：fetched / monitored 笔记
// 的 likes/collects/shares/comments 为 nullable，未读到就是 null，
// 绝不写 0；快照表四项指标 NOT NULL DEFAULT 0。
// 数据从空开始，绝不要写任何真实账号或笔记数据进去。

export const COLUMNS = {
  settings: ['id', 'data_dir_label', 'updated_at'],
  accounts: [
    'id', 'nickname', 'xhs_id', 'homepage', 'avatar_url', 'avatar_source_url',
    'avatar_blob_key', 'followers_count', 'following_count', 'likes_collects_count',
    'note', 'monitored', 'login_status', 'login_verified_at', 'login_message',
    'login_task_id', 'fetch_status', 'fetch_message', 'fetch_task_id',
    'fetched_count', 'fetched_at', 'info_fetch_status', 'info_fetch_message',
    'info_fetch_task_id', 'image_fetch_status', 'image_fetch_message',
    'image_fetch_task_id', 'created_at',
  ],
  fetched_notes: [
    'id', 'account_id', 'title', 'url', 'excerpt', 'likes', 'collects',
    'comments', 'shares', 'published_label', 'images_json', 'fetched_at', 'created_at',
  ],
  assets: [
    'id', 'name', 'relative_path', 'folder_label', 'mime_type', 'size_bytes',
    'blob_key', 'created_at',
  ],
  notes: [
    'id', 'account_id', 'title', 'body', 'tags_json', 'topic', 'status',
    'image_ids_json', 'image_captions_json', 'fetched_images_json', 'source',
    'source_url', 'published_at', 'created_at', 'updated_at',
  ],
  metric_snapshots: [
    'id', 'note_id', 'likes', 'collects', 'shares', 'comments', 'recorded_at',
    'captured_at',
  ],
  monitored_accounts: [
    'id', 'nickname', 'xhs_id', 'homepage', 'avatar_url', 'avatar_source_url',
    'avatar_blob_key', 'followers_count', 'following_count', 'likes_collects_count',
    'note', 'fetch_status', 'fetch_message', 'fetch_task_id', 'fetched_count',
    'fetched_at', 'created_at',
  ],
  monitored_notes: [
    'id', 'monitored_account_id', 'title', 'url', 'excerpt', 'likes', 'collects',
    'comments', 'shares', 'published_label', 'images_json', 'fetched_at', 'created_at',
  ],
  monitored_snapshots: [
    'id', 'monitored_note_id', 'likes', 'collects', 'shares', 'comments',
    'recorded_at', 'captured_at',
  ],
  login_session: [
    'id', 'account_id', 'gate_state', 'browser_state', 'handshake_status',
    'handshake_message', 'handshake_task_id', 'last_handshake_at',
    'last_verified_at', 'qr_auto_opened_at', 'qr_last_opened_at', 'updated_at',
  ],
}

function buildDefaults(clock) {
  const nowIso = () => clock.nowIso()
  const nowMs = () => clock.now()
  return {
    settings: { data_dir_label: '', updated_at: () => nowIso() },
    accounts: {
      nickname: '', xhs_id: '', homepage: '', avatar_url: '', avatar_source_url: '',
      avatar_blob_key: null, followers_count: null, following_count: null,
      likes_collects_count: null, note: '', monitored: 0, login_status: 'unverified',
      login_verified_at: null, login_message: '', login_task_id: '',
      fetch_status: 'idle', fetch_message: '', fetch_task_id: '', fetched_count: 0,
      fetched_at: null, info_fetch_status: 'idle', info_fetch_message: '',
      info_fetch_task_id: '', image_fetch_status: 'idle', image_fetch_message: '',
      image_fetch_task_id: '', created_at: () => nowIso(),
    },
    fetched_notes: {
      account_id: null, title: '', url: '', excerpt: '', likes: null, collects: null,
      comments: null, shares: null, published_label: '', images_json: '[]',
      fetched_at: () => nowIso(), created_at: () => nowIso(),
    },
    assets: {
      name: '', relative_path: '', folder_label: '', mime_type: 'image/jpeg',
      size_bytes: 0, blob_key: '', created_at: () => nowIso(),
    },
    notes: {
      account_id: null, title: '', body: '', tags_json: '[]', topic: '',
      status: 'draft', image_ids_json: '[]', image_captions_json: '[]',
      fetched_images_json: '[]', source: 'local', source_url: '', published_at: null,
      created_at: () => nowIso(), updated_at: () => nowIso(),
    },
    metric_snapshots: {
      note_id: null, likes: 0, collects: 0, shares: 0, comments: 0,
      recorded_at: () => nowIso(), captured_at: () => nowIso(),
    },
    monitored_accounts: {
      nickname: '', xhs_id: '', homepage: '', avatar_url: '', avatar_source_url: '',
      avatar_blob_key: null, followers_count: null, following_count: null,
      likes_collects_count: null, note: '', fetch_status: 'idle', fetch_message: '',
      fetch_task_id: '', fetched_count: 0, fetched_at: null, created_at: () => nowIso(),
    },
    monitored_notes: {
      monitored_account_id: null, title: '', url: '', excerpt: '', likes: null,
      collects: null, comments: null, shares: null, published_label: '',
      images_json: '[]', fetched_at: () => nowIso(), created_at: () => nowIso(),
    },
    monitored_snapshots: {
      monitored_note_id: null, likes: 0, collects: 0, shares: 0, comments: 0,
      recorded_at: () => nowIso(), captured_at: () => nowIso(),
    },
    login_session: {
      account_id: null, gate_state: 'unknown', browser_state: 'unknown',
      handshake_status: 'idle', handshake_message: '', handshake_task_id: '',
      last_handshake_at: null, last_verified_at: null, qr_auto_opened_at: null,
      qr_last_opened_at: null, updated_at: () => nowMs(),
    },
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  data_dir_label TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  xhs_id TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  avatar_source_url TEXT NOT NULL DEFAULT '',
  avatar_blob_key TEXT,
  followers_count INTEGER,
  following_count INTEGER,
  likes_collects_count INTEGER,
  note TEXT NOT NULL DEFAULT '',
  monitored INTEGER NOT NULL DEFAULT 0,
  login_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (login_status IN ('unverified','verifying','verified','failed')),
  login_verified_at TEXT,
  login_message TEXT NOT NULL DEFAULT '',
  login_task_id TEXT NOT NULL DEFAULT '',
  fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (fetch_status IN ('idle','fetching','done','failed')),
  fetch_message TEXT NOT NULL DEFAULT '',
  fetch_task_id TEXT NOT NULL DEFAULT '',
  fetched_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT,
  info_fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (info_fetch_status IN ('idle','fetching','done','failed')),
  info_fetch_message TEXT NOT NULL DEFAULT '',
  info_fetch_task_id TEXT NOT NULL DEFAULT '',
  image_fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (image_fetch_status IN ('idle','fetching','done','failed')),
  image_fetch_message TEXT NOT NULL DEFAULT '',
  image_fetch_task_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fetched_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  likes INTEGER,
  collects INTEGER,
  comments INTEGER,
  shares INTEGER,
  published_label TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL DEFAULT '',
  folder_label TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  blob_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  topic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  image_ids_json TEXT NOT NULL DEFAULT '[]',
  image_captions_json TEXT NOT NULL DEFAULT '[]',
  fetched_images_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','fetched')),
  source_url TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  collects INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitored_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL DEFAULT '',
  xhs_id TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  avatar_source_url TEXT NOT NULL DEFAULT '',
  avatar_blob_key TEXT,
  followers_count INTEGER,
  following_count INTEGER,
  likes_collects_count INTEGER,
  note TEXT NOT NULL DEFAULT '',
  fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (fetch_status IN ('idle','fetching','done','failed')),
  fetch_message TEXT NOT NULL DEFAULT '',
  fetch_task_id TEXT NOT NULL DEFAULT '',
  fetched_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitored_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitored_account_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  likes INTEGER,
  collects INTEGER,
  comments INTEGER,
  shares INTEGER,
  published_label TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitored_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitored_note_id INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  collects INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_session (
  id INTEGER PRIMARY KEY,
  account_id INTEGER,
  gate_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (gate_state IN ('unknown','checking','valid','expired','needs_scan')),
  browser_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (browser_state IN ('unknown','logged_in','logged_out')),
  handshake_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (handshake_status IN ('idle','checking','valid','expired','unknown','failed')),
  handshake_message TEXT NOT NULL DEFAULT '',
  handshake_task_id TEXT NOT NULL DEFAULT '',
  last_handshake_at INTEGER,
  last_verified_at INTEGER,
  qr_auto_opened_at INTEGER,
  qr_last_opened_at INTEGER,
  updated_at INTEGER NOT NULL
);
`

function applyDefaults(table, row, defaults) {
  const out = {}
  for (const col of COLUMNS[table]) {
    if (row[col] !== undefined) {
      out[col] = row[col]
    } else if (col === 'id') {
      // id 由后端分配
    } else {
      const def = defaults[table][col]
      out[col] = typeof def === 'function' ? def() : def
    }
  }
  if (row.id != null) out.id = row.id
  return out
}

function pickColumns(table, patch) {
  const out = {}
  for (const col of COLUMNS[table]) {
    if (col === 'id') continue
    if (patch[col] !== undefined) out[col] = patch[col]
  }
  return out
}

export function createStore({ storage, clock, logger = null }) {
  const nowIso = () => clock.nowIso()
  const nowMs = () => clock.now()
  const defaults = buildDefaults(clock)
  storage.exec(DDL)

  // ---- 底层原语（全部经注入的 storage 接口） ----
  function lowAll(table, where = {}, orderBy = 'id ASC') {
    return storage.all(table, where, orderBy)
  }

  function lowGet(table, id) {
    if (id == null) return null
    return storage.get(table, id) ?? null
  }

  function lowInsert(table, row) {
    const full = applyDefaults(table, row, defaults)
    return storage.insert(table, full)
  }

  function lowUpdate(table, id, patch) {
    const clean = pickColumns(table, patch)
    if (Object.keys(clean).length === 0) return lowGet(table, id)
    return storage.update(table, id, clean)
  }

  function lowDelete(table, id) {
    storage.delete(table, id)
  }

  function lowEnsure(table, id, defaultsRow) {
    const existing = lowGet(table, id)
    if (existing) return existing
    return lowInsert(table, { id, ...defaultsRow })
  }

  // ---- Blob 文件 ----
  function saveBlobFile(blobKey, buffer) {
    // 返回 blob 文件完整路径（与旧版一致）。
    return storage.writeBlob(blobKey, buffer)
  }
  function readBlobFile(blobKey) {
    return storage.readBlob(blobKey)
  }
  function deleteBlobFile(blobKey) {
    storage.deleteBlob(blobKey)
  }

  // ---- settings（单行 id=1） ----
  function getSettings() {
    return lowEnsure('settings', 1, { data_dir_label: '', updated_at: nowIso() })
  }
  function updateSettings(patch) {
    return lowUpdate('settings', 1, { ...pickColumns('settings', patch), updated_at: nowIso() })
  }

  // ---- login_session（单行 id=1，懒创建/种子） ----
  function getLoginSession() {
    const existing = lowGet('login_session', 1)
    if (existing) return existing
    // 种子：有 loginStatus='verified' 的主账号则 gateState 为 'valid'，否则 'unknown'
    const hasVerified = lowAll('accounts').some((a) => a.login_status === 'verified')
    return lowInsert('login_session', {
      id: 1,
      gate_state: hasVerified ? 'valid' : 'unknown',
      updated_at: nowMs(),
    })
  }
  function updateLoginSession(patch) {
    getLoginSession()
    return lowUpdate('login_session', 1, { ...patch, updated_at: nowMs() })
  }

  // ---- accounts（绑定/主账号） ----
  function listAccounts() {
    return lowAll('accounts', {}, 'monitored DESC, id ASC')
  }
  function getAccount(id) {
    return lowGet('accounts', id)
  }
  function getAccountByXhsId(xhsId) {
    if (!xhsId) return null
    return lowAll('accounts', { xhs_id: xhsId })[0] ?? null
  }
  function getPrimaryAccount() {
    return listAccounts()[0] ?? null
  }
  function upsertAccount(data) {
    const xhsId = data.xhs_id ?? data.xhsId ?? ''
    let existing = null
    if (xhsId) existing = getAccountByXhsId(xhsId)
    if (!existing && data.homepage) {
      existing = lowAll('accounts', { homepage: data.homepage })[0] ?? null
    }
    if (existing) return lowUpdate('accounts', existing.id, data)
    return lowInsert('accounts', data)
  }
  function updateAccount(id, patch) {
    return lowUpdate('accounts', id, patch)
  }
  function deleteAccount(id) {
    for (const note of lowAll('fetched_notes', { account_id: id })) {
      lowDelete('fetched_notes', note.id)
    }
    for (const note of lowAll('notes', { account_id: id })) {
      lowUpdate('notes', note.id, { account_id: null })
    }
    lowDelete('accounts', id)
  }

  // ---- fetched_notes ----
  function listFetchedNotes(accountId = null) {
    if (accountId == null) return lowAll('fetched_notes', {}, 'id ASC')
    return lowAll('fetched_notes', { account_id: accountId }, 'id ASC')
  }
  function upsertFetchedNotes(accountId, notes) {
    const now = nowIso()
    let inserted = 0
    let updated = 0
    const saved = []
    for (const raw of (notes ?? []).slice(0, 20)) {
      const note = {
        account_id: accountId,
        title: raw.title ?? '',
        url: raw.url ?? '',
        excerpt: raw.excerpt ?? '',
        likes: raw.likes ?? null,
        collects: raw.collects ?? null,
        comments: raw.comments ?? null,
        shares: raw.shares ?? null,
        published_label: raw.publishedLabel ?? raw.published_label ?? '',
        images_json: JSON.stringify(raw.imageUrls ?? raw.images ?? []),
        fetched_at: now,
      }
      const existing = lowAll('fetched_notes', { account_id: accountId }).find((row) =>
        note.url ? row.url === note.url : row.title === note.title && row.title !== '',
      )
      if (existing) {
        saved.push(lowUpdate('fetched_notes', existing.id, note))
        updated += 1
      } else {
        saved.push(lowInsert('fetched_notes', note))
        inserted += 1
      }
    }
    return { saved, inserted, updated, total: saved.length }
  }
  function cleanupUnverifiedFetchedNotes() {
    const verifiedIds = new Set(
      lowAll('accounts').filter((a) => a.login_status === 'verified').map((a) => a.id),
    )
    let deleted = 0
    for (const note of lowAll('fetched_notes')) {
      if (!verifiedIds.has(note.account_id)) {
        lowDelete('fetched_notes', note.id)
        deleted += 1
      }
    }
    return deleted
  }

  // ---- assets ----
  function listAssets() {
    return lowAll('assets', {}, 'id ASC')
  }
  function getAsset(id) {
    return lowGet('assets', id)
  }
  function createAsset(data) {
    return lowInsert('assets', data)
  }
  function deleteAsset(id) {
    const asset = lowGet('assets', id)
    if (asset?.blob_key) deleteBlobFile(asset.blob_key)
    lowDelete('assets', id)
  }

  // ---- notes（草稿/已发布） ----
  function listNotes() {
    return lowAll('notes', {}, 'id DESC')
  }
  function getNote(id) {
    return lowGet('notes', id)
  }
  function createNote(data) {
    return lowInsert('notes', data)
  }
  function updateNote(id, patch) {
    return lowUpdate('notes', id, { ...patch, updated_at: nowIso() })
  }
  function deleteNote(id) {
    for (const snap of lowAll('metric_snapshots', { note_id: id })) {
      lowDelete('metric_snapshots', snap.id)
    }
    lowDelete('notes', id)
  }

  // ---- metric_snapshots ----
  function listSnapshots(noteId) {
    return lowAll('metric_snapshots', { note_id: noteId }, 'id ASC')
  }
  function recordSnapshot(noteId, metrics) {
    const now = nowIso()
    return lowInsert('metric_snapshots', {
      note_id: noteId,
      likes: metrics.likes ?? 0,
      collects: metrics.collects ?? 0,
      shares: metrics.shares ?? 0,
      comments: metrics.comments ?? 0,
      recorded_at: now,
      captured_at: now,
    })
  }

  // ---- monitored_accounts（监测账号，与绑定账号彻底分离） ----
  function listMonitoredAccounts() {
    return lowAll('monitored_accounts', {}, 'id ASC')
  }
  function getMonitoredAccount(id) {
    return lowGet('monitored_accounts', id)
  }
  function getMonitoredAccountByHomepage(homepage) {
    if (!homepage) return null
    return lowAll('monitored_accounts', { homepage })[0] ?? null
  }
  function upsertMonitoredAccount(data) {
    let existing = null
    if (data.homepage) existing = getMonitoredAccountByHomepage(data.homepage)
    if (!existing && data.xhs_id) {
      existing = lowAll('monitored_accounts', { xhs_id: data.xhs_id })[0] ?? null
    }
    if (existing) return lowUpdate('monitored_accounts', existing.id, data)
    return lowInsert('monitored_accounts', data)
  }
  function updateMonitoredAccount(id, patch) {
    return lowUpdate('monitored_accounts', id, patch)
  }
  function deleteMonitoredAccount(id) {
    for (const note of lowAll('monitored_notes', { monitored_account_id: id })) {
      for (const snap of lowAll('monitored_snapshots', { monitored_note_id: note.id })) {
        lowDelete('monitored_snapshots', snap.id)
      }
      lowDelete('monitored_notes', note.id)
    }
    lowDelete('monitored_accounts', id)
  }

  // ---- monitored_notes / monitored_snapshots ----
  function listMonitoredNotes(monitoredAccountId) {
    return lowAll('monitored_notes', { monitored_account_id: monitoredAccountId }, 'id ASC')
  }
  function upsertMonitoredNotes(monitoredAccountId, notes) {
    const now = nowIso()
    let inserted = 0
    let updated = 0
    const saved = []
    for (const raw of (notes ?? []).slice(0, 20)) {
      const note = {
        monitored_account_id: monitoredAccountId,
        title: raw.title ?? '',
        url: raw.url ?? '',
        excerpt: raw.excerpt ?? '',
        likes: raw.likes ?? null,
        collects: raw.collects ?? null,
        comments: raw.comments ?? null,
        shares: raw.shares ?? null,
        published_label: raw.publishedLabel ?? raw.published_label ?? '',
        images_json: JSON.stringify(raw.imageUrls ?? raw.images ?? []),
        fetched_at: now,
      }
      const existing = lowAll('monitored_notes', {
        monitored_account_id: monitoredAccountId,
      }).find((row) =>
        note.url ? row.url === note.url : row.title === note.title && row.title !== '',
      )
      if (existing) {
        saved.push(lowUpdate('monitored_notes', existing.id, note))
        updated += 1
      } else {
        saved.push(lowInsert('monitored_notes', note))
        inserted += 1
      }
    }
    return { saved, inserted, updated, total: saved.length }
  }
  function listMonitoredSnapshots(monitoredNoteId) {
    return lowAll('monitored_snapshots', { monitored_note_id: monitoredNoteId }, 'id ASC')
  }
  function recordMonitoredSnapshot(monitoredNoteId, metrics) {
    const now = nowIso()
    return lowInsert('monitored_snapshots', {
      monitored_note_id: monitoredNoteId,
      likes: metrics.likes ?? 0,
      collects: metrics.collects ?? 0,
      shares: metrics.shares ?? 0,
      comments: metrics.comments ?? 0,
      recorded_at: now,
      captured_at: now,
    })
  }

  // ---- saveNoteImages：按 url（无 url 按 title）匹配已拉取笔记写回配图 ----
  function saveNoteImages(accountId, items) {
    let updated = 0
    for (const item of (items ?? []).slice(0, 20)) {
      const url = item.url ?? ''
      const title = item.title ?? ''
      const images = (item.imageUrls ?? item.images ?? []).slice(0, 9)
      const existing = lowAll('fetched_notes', { account_id: accountId }).find((row) =>
        url ? row.url === url : row.title === title && title !== '',
      )
      if (existing) {
        lowUpdate('fetched_notes', existing.id, { images_json: JSON.stringify(images) })
        updated += 1
      }
    }
    return updated
  }

  function close() {
    try {
      storage.close()
    } catch (error) {
      logger?.error?.('[core/store] 关闭存储失败:', error)
    }
  }

  return {
    getSettings,
    updateSettings,
    getLoginSession,
    updateLoginSession,
    listAccounts,
    getAccount,
    getAccountByXhsId,
    getPrimaryAccount,
    upsertAccount,
    updateAccount,
    deleteAccount,
    listFetchedNotes,
    upsertFetchedNotes,
    cleanupUnverifiedFetchedNotes,
    listAssets,
    getAsset,
    createAsset,
    deleteAsset,
    saveBlobFile,
    readBlobFile,
    deleteBlobFile,
    listNotes,
    getNote,
    createNote,
    updateNote,
    deleteNote,
    listSnapshots,
    recordSnapshot,
    listMonitoredAccounts,
    getMonitoredAccount,
    getMonitoredAccountByHomepage,
    upsertMonitoredAccount,
    updateMonitoredAccount,
    deleteMonitoredAccount,
    listMonitoredNotes,
    upsertMonitoredNotes,
    listMonitoredSnapshots,
    recordMonitoredSnapshot,
    saveNoteImages,
    close,
  }
}
