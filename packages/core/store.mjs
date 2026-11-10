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
// 约定（v0.2.0，与 Muse 一致）：
// - 列名用 snake_case；时间一律用毫秒时间戳 INTEGER（与 Muse 的
//   timestamp_ms 一致），出接口时由调用方转 ISO 字符串 / YYYY-MM-DD。
//   既有 DSH 数据的迁移（ISO 文本 -> 毫秒、多余列删除、login_session
//   行并入 accounts 后删表）由 dsh/adapters.mjs 在建库时做，见该文件。
// - 指标 null 与 0 要区分：fetched / monitored 笔记的
//   likes/collects/shares/comments 为 nullable，未读到就是 null，
//   绝不写 0；快照表四项指标 NOT NULL DEFAULT 0。
// - login_session 表已删除（Muse 0016 已 DROP）：门禁唯一存储是
//   accounts 行上的 gate_* / gate_shared_* 列，本文件任何地方都不
//   再读写 login_session。
// 数据从空开始，绝不要写任何真实账号或笔记数据进去。

export const COLUMNS = {
  settings: [
    'id', 'data_dir_label', 'image_api_base_url', 'image_api_key', 'image_api_model',
    'image_api_key_updated_at', 'preferred_image_backend', 'first_use_login_prompted_at',
    'hotspot_keywords_json', 'hotspot_interval_hours', 'hotspot_enabled', 'updated_at',
  ],
  accounts: [
    'id', 'nickname', 'xhs_id', 'homepage', 'note', 'following_count', 'followers_count',
    'likes_collects_count', 'avatar_source_url', 'avatar_blob_key', 'monitored',
    'fetch_status', 'fetch_task_id', 'fetch_message', 'fetched_at',
    'login_status', 'login_task_id', 'login_message', 'login_verified_at',
    'info_fetch_status', 'info_fetch_message', 'info_fetch_task_id', 'info_fetch_started_at',
    'image_fetch_status', 'image_fetch_task_id', 'image_fetch_message',
    'detail_fetch_status', 'detail_fetch_task_id', 'detail_fetch_message',
    'detail_fetch_total', 'detail_fetch_done',
    'gate_state', 'gate_last_verified_at', 'gate_last_handshake_at',
    'gate_handshake_status', 'gate_handshake_task_id', 'gate_handshake_message',
    'gate_browser_state', 'gate_qr_auto_opened_at', 'gate_qr_last_opened_at',
    'gate_shared_state', 'gate_shared_at', 'gate_shared_message',
    'gate_shared_nickname', 'gate_shared_xhs_id', 'gate_updated_at',
    'created_at',
  ],
  fetched_notes: [
    'id', 'account_id', 'title', 'url', 'excerpt', 'likes', 'collects',
    'shares', 'comments', 'published_label', 'published_at', 'images_json', 'fetched_at',
  ],
  assets: [
    'id', 'name', 'relative_path', 'folder_label', 'mime_type', 'size_bytes',
    'blob_key', 'created_at',
  ],
  notes: [
    'id', 'account_id', 'title', 'body', 'tags_json', 'image_ids_json',
    'image_captions_json', 'topic', 'fetched_images_json', 'source',
    'source_url', 'status', 'created_at', 'updated_at', 'published_at',
  ],
  metric_snapshots: [
    'id', 'note_id', 'likes', 'collects', 'shares', 'comments', 'captured_at',
  ],
  monitored_accounts: [
    'id', 'nickname', 'xhs_id', 'homepage', 'note', 'following_count',
    'followers_count', 'likes_collects_count', 'avatar_source_url', 'avatar_blob_key',
    'fetch_status', 'fetch_task_id', 'fetch_message', 'fetched_at', 'created_at',
  ],
  monitored_notes: [
    'id', 'monitored_account_id', 'title', 'url', 'excerpt', 'likes', 'collects',
    'shares', 'comments', 'published_label', 'images_json', 'fetched_at',
  ],
  monitored_snapshots: [
    'id', 'monitored_note_id', 'likes', 'collects', 'shares', 'comments', 'captured_at',
  ],
  competitor_notifications: [
    'id', 'monitored_account_id', 'monitored_note_id', 'type', 'title', 'body',
    'note_title', 'note_url', 'likes', 'is_read', 'created_at',
  ],
  hotspot_items: [
    'id', 'source', 'title', 'summary', 'url', 'keyword', 'author', 'fetched_at',
  ],
  hotspot_state: [
    'id', 'xhs_status', 'xhs_task_id', 'xhs_message', 'xhs_last_fetched_at',
    'xhs_last_attempt_at', 'x_status', 'x_task_id', 'x_message', 'x_last_fetched_at',
    'x_last_attempt_at', 'x_login_status', 'x_login_message', 'x_login_checked_at',
    'x_login_task_id', 'x_login_check_method', 'x_login_browsed_json', 'updated_at',
  ],
  lead_state: [
    'id', 'dm_status', 'dm_task_id', 'dm_message', 'dm_last_fetched_at',
    'dm_last_attempt_at', 'dm_unread_total', 'dm_conversation_count', 'updated_at',
  ],
  lead_dm_conversations: [
    'id', 'conversation_key', 'sender_name', 'preview', 'unread_count',
    'time_label', 'fetched_at',
  ],
  lead_notifications: [
    'id', 'type', 'title', 'body', 'sender_name', 'preview', 'note_title',
    'note_url', 'comments', 'comment_delta', 'is_read', 'created_at',
  ],
  shared_session_requests: [
    'id', 'kind', 'account_id', 'monitored_account_id', 'note_id', 'payload',
    'status', 'message', 'result_message', 'created_at', 'updated_at', 'fulfilled_at',
  ],
}

// 时间列（毫秒 INTEGER）：供适配层做 ISO 文本 -> 毫秒的数据迁移用。
export const TIME_COLUMNS = {
  settings: ['image_api_key_updated_at', 'first_use_login_prompted_at', 'updated_at'],
  accounts: [
    'fetched_at', 'login_verified_at', 'info_fetch_started_at', 'gate_last_verified_at',
    'gate_last_handshake_at', 'gate_qr_auto_opened_at', 'gate_qr_last_opened_at',
    'gate_shared_at', 'gate_updated_at', 'created_at',
  ],
  fetched_notes: ['published_at', 'fetched_at'],
  assets: ['created_at'],
  notes: ['created_at', 'updated_at', 'published_at'],
  metric_snapshots: ['captured_at'],
  monitored_accounts: ['fetched_at', 'created_at'],
  monitored_notes: ['fetched_at'],
  monitored_snapshots: ['captured_at'],
  competitor_notifications: ['created_at'],
  hotspot_items: ['fetched_at'],
  hotspot_state: [
    'xhs_last_fetched_at', 'xhs_last_attempt_at', 'x_last_fetched_at',
    'x_last_attempt_at', 'x_login_checked_at', 'updated_at',
  ],
  lead_state: ['dm_last_fetched_at', 'dm_last_attempt_at', 'updated_at'],
  lead_dm_conversations: ['fetched_at'],
  lead_notifications: ['created_at'],
  shared_session_requests: ['created_at', 'updated_at', 'fulfilled_at'],
}

function buildDefaults(clock) {
  const nowMs = () => clock.now()
  return {
    settings: {
      data_dir_label: '', image_api_base_url: '', image_api_key: '', image_api_model: '',
      image_api_key_updated_at: null, preferred_image_backend: 'muse',
      first_use_login_prompted_at: null, hotspot_keywords_json: '[]',
      hotspot_interval_hours: 6, hotspot_enabled: 1, updated_at: () => nowMs(),
    },
    accounts: {
      nickname: '', xhs_id: '', homepage: '', note: '', following_count: null,
      followers_count: null, likes_collects_count: null, avatar_source_url: '',
      avatar_blob_key: null, monitored: 0, fetch_status: 'idle', fetch_task_id: '',
      fetch_message: '', fetched_at: null, login_status: 'unverified', login_task_id: '',
      login_message: '', login_verified_at: null, info_fetch_status: 'idle',
      info_fetch_message: '', info_fetch_task_id: '', info_fetch_started_at: null,
      image_fetch_status: 'idle', image_fetch_task_id: '', image_fetch_message: '',
      detail_fetch_status: 'idle', detail_fetch_task_id: '', detail_fetch_message: '',
      detail_fetch_total: 0, detail_fetch_done: 0,
      gate_state: 'unknown', gate_last_verified_at: null, gate_last_handshake_at: null,
      gate_handshake_status: 'idle', gate_handshake_task_id: '', gate_handshake_message: '',
      gate_browser_state: 'unknown', gate_qr_auto_opened_at: null, gate_qr_last_opened_at: null,
      gate_shared_state: 'unknown', gate_shared_at: null, gate_shared_message: '',
      gate_shared_nickname: '', gate_shared_xhs_id: '', gate_updated_at: 0,
      created_at: () => nowMs(),
    },
    fetched_notes: {
      account_id: null, title: '', url: '', excerpt: '', likes: null, collects: null,
      shares: null, comments: null, published_label: '', published_at: null,
      images_json: '[]', fetched_at: () => nowMs(),
    },
    assets: {
      name: '', relative_path: '', folder_label: '', mime_type: 'image/jpeg',
      size_bytes: 0, blob_key: '', created_at: () => nowMs(),
    },
    notes: {
      account_id: null, title: '', body: '', tags_json: '[]', image_ids_json: '[]',
      image_captions_json: '[]', topic: '', fetched_images_json: '[]', source: 'local',
      source_url: '', status: 'draft', created_at: () => nowMs(), updated_at: () => nowMs(),
      published_at: null,
    },
    metric_snapshots: {
      note_id: null, likes: 0, collects: 0, shares: 0, comments: 0,
      captured_at: () => nowMs(),
    },
    monitored_accounts: {
      nickname: '', xhs_id: '', homepage: '', note: '', following_count: null,
      followers_count: null, likes_collects_count: null, avatar_source_url: '',
      avatar_blob_key: null, fetch_status: 'idle', fetch_task_id: '', fetch_message: '',
      fetched_at: null, created_at: () => nowMs(),
    },
    monitored_notes: {
      monitored_account_id: null, title: '', url: '', excerpt: '', likes: null,
      collects: null, shares: null, comments: null, published_label: '',
      images_json: '[]', fetched_at: () => nowMs(),
    },
    monitored_snapshots: {
      monitored_note_id: null, likes: 0, collects: 0, shares: 0, comments: 0,
      captured_at: () => nowMs(),
    },
    competitor_notifications: {
      monitored_account_id: null, monitored_note_id: null, type: 'new_note', title: '',
      body: '', note_title: '', note_url: '', likes: null, is_read: 0,
      created_at: () => nowMs(),
    },
    hotspot_items: {
      source: 'xiaohongshu', title: '', summary: '', url: '', keyword: '', author: '',
      fetched_at: () => nowMs(),
    },
    hotspot_state: {
      xhs_status: 'idle', xhs_task_id: '', xhs_message: '', xhs_last_fetched_at: null,
      xhs_last_attempt_at: null, x_status: 'idle', x_task_id: '', x_message: '',
      x_last_fetched_at: null, x_last_attempt_at: null, x_login_status: 'unknown',
      x_login_message: '', x_login_checked_at: null, x_login_task_id: '',
      x_login_check_method: '', x_login_browsed_json: '[]', updated_at: () => nowMs(),
    },
    lead_state: {
      dm_status: 'idle', dm_task_id: '', dm_message: '', dm_last_fetched_at: null,
      dm_last_attempt_at: null, dm_unread_total: null, dm_conversation_count: null,
      updated_at: () => nowMs(),
    },
    lead_dm_conversations: {
      conversation_key: '', sender_name: '', preview: '', unread_count: 0,
      time_label: '', fetched_at: () => nowMs(),
    },
    lead_notifications: {
      type: 'new_dm', title: '', body: '', sender_name: '', preview: '', note_title: '',
      note_url: '', comments: null, comment_delta: null, is_read: 0,
      created_at: () => nowMs(),
    },
    shared_session_requests: {
      kind: '', account_id: null, monitored_account_id: null, note_id: null, payload: '',
      status: 'pending', message: '', result_message: '', created_at: () => nowMs(),
      updated_at: () => nowMs(), fulfilled_at: null,
    },
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  data_dir_label TEXT NOT NULL DEFAULT '',
  image_api_base_url TEXT NOT NULL DEFAULT '',
  image_api_key TEXT NOT NULL DEFAULT '',
  image_api_model TEXT NOT NULL DEFAULT '',
  image_api_key_updated_at INTEGER,
  preferred_image_backend TEXT NOT NULL DEFAULT 'muse'
    CHECK (preferred_image_backend IN ('muse','dsh','api')),
  first_use_login_prompted_at INTEGER,
  hotspot_keywords_json TEXT NOT NULL DEFAULT '[]',
  hotspot_interval_hours INTEGER NOT NULL DEFAULT 6,
  hotspot_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  xhs_id TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  following_count INTEGER,
  followers_count INTEGER,
  likes_collects_count INTEGER,
  avatar_source_url TEXT NOT NULL DEFAULT '',
  avatar_blob_key TEXT,
  monitored INTEGER NOT NULL DEFAULT 0,
  fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (fetch_status IN ('idle','fetching','done','failed')),
  fetch_task_id TEXT NOT NULL DEFAULT '',
  fetch_message TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER,
  login_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (login_status IN ('unverified','verifying','verified','failed')),
  login_task_id TEXT NOT NULL DEFAULT '',
  login_message TEXT NOT NULL DEFAULT '',
  login_verified_at INTEGER,
  info_fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (info_fetch_status IN ('idle','fetching','done','failed')),
  info_fetch_message TEXT NOT NULL DEFAULT '',
  info_fetch_task_id TEXT NOT NULL DEFAULT '',
  info_fetch_started_at INTEGER,
  image_fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (image_fetch_status IN ('idle','fetching','done','failed')),
  image_fetch_task_id TEXT NOT NULL DEFAULT '',
  image_fetch_message TEXT NOT NULL DEFAULT '',
  detail_fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (detail_fetch_status IN ('idle','fetching','done','failed')),
  detail_fetch_task_id TEXT NOT NULL DEFAULT '',
  detail_fetch_message TEXT NOT NULL DEFAULT '',
  detail_fetch_total INTEGER NOT NULL DEFAULT 0,
  detail_fetch_done INTEGER NOT NULL DEFAULT 0,
  gate_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (gate_state IN ('unknown','checking','valid','expired','needs_scan')),
  gate_last_verified_at INTEGER,
  gate_last_handshake_at INTEGER,
  gate_handshake_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (gate_handshake_status IN ('idle','checking','valid','expired','unknown','failed')),
  gate_handshake_task_id TEXT NOT NULL DEFAULT '',
  gate_handshake_message TEXT NOT NULL DEFAULT '',
  gate_browser_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (gate_browser_state IN ('unknown','logged_in','logged_out')),
  gate_qr_auto_opened_at INTEGER,
  gate_qr_last_opened_at INTEGER,
  gate_shared_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (gate_shared_state IN ('unknown','logged_in','logged_out')),
  gate_shared_at INTEGER,
  gate_shared_message TEXT NOT NULL DEFAULT '',
  gate_shared_nickname TEXT NOT NULL DEFAULT '',
  gate_shared_xhs_id TEXT NOT NULL DEFAULT '',
  gate_updated_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fetched_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  likes INTEGER,
  collects INTEGER,
  shares INTEGER,
  comments INTEGER,
  published_label TEXT NOT NULL DEFAULT '',
  published_at INTEGER,
  images_json TEXT NOT NULL DEFAULT '[]',
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL DEFAULT '',
  folder_label TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  blob_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  image_ids_json TEXT NOT NULL DEFAULT '[]',
  image_captions_json TEXT NOT NULL DEFAULT '[]',
  topic TEXT NOT NULL DEFAULT '',
  fetched_images_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','fetched')),
  source_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  collects INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monitored_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL DEFAULT '',
  xhs_id TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  following_count INTEGER,
  followers_count INTEGER,
  likes_collects_count INTEGER,
  avatar_source_url TEXT NOT NULL DEFAULT '',
  avatar_blob_key TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (fetch_status IN ('idle','fetching','done','failed')),
  fetch_task_id TEXT NOT NULL DEFAULT '',
  fetch_message TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monitored_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitored_account_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  likes INTEGER,
  collects INTEGER,
  shares INTEGER,
  comments INTEGER,
  published_label TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monitored_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitored_note_id INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  collects INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS competitor_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitored_account_id INTEGER NOT NULL,
  monitored_note_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('new_note','likes_over_5')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  note_title TEXT NOT NULL DEFAULT '',
  note_url TEXT NOT NULL DEFAULT '',
  likes INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hotspot_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('xiaohongshu','x')),
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hotspot_state (
  id INTEGER PRIMARY KEY,
  xhs_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (xhs_status IN ('idle','fetching','done','failed')),
  xhs_task_id TEXT NOT NULL DEFAULT '',
  xhs_message TEXT NOT NULL DEFAULT '',
  xhs_last_fetched_at INTEGER,
  xhs_last_attempt_at INTEGER,
  x_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (x_status IN ('idle','fetching','done','failed')),
  x_task_id TEXT NOT NULL DEFAULT '',
  x_message TEXT NOT NULL DEFAULT '',
  x_last_fetched_at INTEGER,
  x_last_attempt_at INTEGER,
  x_login_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (x_login_status IN ('unknown','checking','logged_in','logged_out')),
  x_login_message TEXT NOT NULL DEFAULT '',
  x_login_checked_at INTEGER,
  x_login_task_id TEXT NOT NULL DEFAULT '',
  x_login_check_method TEXT NOT NULL DEFAULT '',
  x_login_browsed_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lead_state (
  id INTEGER PRIMARY KEY,
  dm_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (dm_status IN ('idle','fetching','done','failed')),
  dm_task_id TEXT NOT NULL DEFAULT '',
  dm_message TEXT NOT NULL DEFAULT '',
  dm_last_fetched_at INTEGER,
  dm_last_attempt_at INTEGER,
  dm_unread_total INTEGER,
  dm_conversation_count INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lead_dm_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  unread_count INTEGER NOT NULL DEFAULT 0,
  time_label TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_dm_conversations_key_idx
  ON lead_dm_conversations (conversation_key);
CREATE TABLE IF NOT EXISTS lead_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('new_dm','new_comment')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  note_title TEXT NOT NULL DEFAULT '',
  note_url TEXT NOT NULL DEFAULT '',
  comments INTEGER,
  comment_delta INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shared_session_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  account_id INTEGER,
  monitored_account_id INTEGER,
  note_id INTEGER,
  payload TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','fulfilled','cancelled')),
  message TEXT NOT NULL DEFAULT '',
  result_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  fulfilled_at INTEGER
);
`

// ---- 发布时间标签换算（照抄 Muse parsePublishedLabel / parseAbsoluteDateString，
// 输入输出均为毫秒时间戳；anchor 为读取日的毫秒时间戳） ----
export function parsePublishedLabel(label, anchorMs = Date.now()) {
  const s = String(label ?? '').trim()
  if (!s) return null
  const anchor = new Date(anchorMs)
  const full = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/)
  if (full) {
    const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]))
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  const daysAgo = (n) => {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    d.setDate(d.getDate() - n)
    return d.getTime()
  }
  let m = s.match(/(\d+)\s*天前/)
  if (m) return daysAgo(Number(m[1]))
  m = s.match(/(\d+)\s*周前/)
  if (m) return daysAgo(Number(m[1]) * 7)
  if (s.includes('前天')) return daysAgo(2)
  if (s.includes('昨天')) return daysAgo(1)
  if (/刚刚|分钟前|小时前|今天/.test(s)) return daysAgo(0)
  m = s.match(/(\d{1,2})[-/月](\d{1,2})日?/)
  if (m) {
    const d = new Date(anchor.getFullYear(), Number(m[1]) - 1, Number(m[2]))
    if (d.getTime() > anchor.getTime()) d.setFullYear(anchor.getFullYear() - 1)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  return null
}

export function parseAbsoluteDateString(value) {
  const m = String(value ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

export function fmtDateKey(ms) {
  if (ms == null) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function toIso(ms) {
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
  // 供适配层迁移后 / 调用方直接按列名取值的兜底：读一行时把旧库残留的
  // 多余列忽略（COLUMNS 之外的键不进入业务逻辑）。

  // ---- Blob 文件 ----
  function saveBlobFile(blobKey, buffer) {
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
    return lowEnsure('settings', 1, { data_dir_label: '', updated_at: nowMs() })
  }
  function updateSettings(patch) {
    return lowUpdate('settings', 1, { ...pickColumns('settings', patch), updated_at: nowMs() })
  }
  function getHotspotConfig() {
    const row = getSettings()
    let keywords = []
    try {
      const parsed = JSON.parse(row.hotspot_keywords_json || '[]')
      if (Array.isArray(parsed)) {
        keywords = parsed.filter((k) => typeof k === 'string' && k.trim() !== '').map((k) => k.trim())
      }
    } catch {
      keywords = []
    }
    const intervalHours =
      row.hotspot_interval_hours >= 1 && row.hotspot_interval_hours <= 24
        ? row.hotspot_interval_hours
        : 6
    return { keywords, intervalHours, enabled: row.hotspot_enabled === 1 }
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
  // 门禁账号选择（照抄 Muse pickGateAccount）：有实质门禁数据的行 ->
  // 首个 verified -> monitored=1 的行 -> 首行。无账号返回 null。
  function getGateAccount() {
    const all = listAccounts()
    return (
      all.find(
        (a) =>
          a.gate_state === 'valid' ||
          a.gate_state === 'expired' ||
          a.gate_state === 'checking' ||
          a.gate_state === 'needs_scan' ||
          a.gate_last_verified_at != null ||
          a.gate_handshake_status !== 'idle',
      ) ??
      all.find((a) => a.login_status === 'verified') ??
      all.find((a) => a.monitored === 1) ??
      all[0] ??
      null
    )
  }
  // 门禁唯一写入口：只写指定账号行的 gate_* / gate_shared_* 列，
  // 并刷新 gate_updated_at。无账号时静默 no-op（门禁由缺失本身推导）。
  function writeGate(accountId, patch) {
    if (accountId == null) return null
    const clean = {}
    for (const key of Object.keys(patch ?? {})) {
      if (key.startsWith('gate_')) clean[key] = patch[key]
    }
    clean.gate_updated_at = nowMs()
    return lowUpdate('accounts', accountId, clean)
  }
  // 门禁懒种子（照抄 Muse ensureLoginSession）：门禁列全是默认值、
  // 但记录态已是 verified 的账号，种子 gate_state='valid'。
  function seedGateFromVerified() {
    const gateAccount = getGateAccount()
    if (!gateAccount) return null
    const untouched =
      gateAccount.gate_state === 'unknown' &&
      gateAccount.gate_handshake_status === 'idle' &&
      gateAccount.gate_last_verified_at == null &&
      gateAccount.gate_browser_state === 'unknown' &&
      gateAccount.gate_shared_state === 'unknown'
    if (untouched && gateAccount.login_status === 'verified') {
      return lowUpdate('accounts', gateAccount.id, {
        gate_state: 'valid',
        gate_last_verified_at: gateAccount.login_verified_at ?? null,
        gate_updated_at: nowMs(),
      })
    }
    return gateAccount
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
  function setMonitoredAccount(id) {
    for (const a of lowAll('accounts')) {
      if (a.monitored === 1) lowUpdate('accounts', a.id, { monitored: 0 })
    }
    return lowUpdate('accounts', id, { monitored: 1 })
  }
  function deleteAccount(id) {
    // Muse deleteAccount：已拉笔记删掉；笔记库笔记保留、解除关联，
    // 并清空其 fetched 配图（fetched_images_json='[]'）。
    for (const note of lowAll('fetched_notes', { account_id: id })) {
      lowDelete('fetched_notes', note.id)
    }
    for (const note of lowAll('notes', { account_id: id })) {
      lowUpdate('notes', note.id, { account_id: null, fetched_images_json: '[]' })
    }
    lowDelete('accounts', id)
  }
  function countFetchedNotes(accountId) {
    return lowAll('fetched_notes', { account_id: accountId }).length
  }

  // ---- fetched_notes ----
  function listFetchedNotes(accountId = null) {
    if (accountId == null) return lowAll('fetched_notes', {}, 'id DESC')
    return lowAll('fetched_notes', { account_id: accountId }, 'id DESC')
  }
  function findFetchedNote(accountId, url, title) {
    const rows = lowAll('fetched_notes', { account_id: accountId })
    return (
      rows.find((r) =>
        url ? r.url !== '' && r.url === url : title !== '' && r.title === title,
      ) ?? null
    )
  }
  // 占位绑定记录合并进已存在账号时，把其已拉笔记改归属到目标账号。
  function reassignFetchedNotes(fromAccountId, toAccountId) {
    for (const row of lowAll('fetched_notes', { account_id: fromAccountId })) {
      lowUpdate('fetched_notes', row.id, { account_id: toAccountId })
    }
  }
  // Muse saveFetchedNotes：整批替换该账号旧拉取列表（不是 upsert 合并）。
  // 返回 { saved, previous }：previous 是替换前各篇的 {title,url,comments}，
  // 供留资评论增量比对用。publishedAt 按“绝对日期优先、相对标签按读取日换算”。
  function replaceFetchedNotes(accountId, notes, anchorMs = nowMs()) {
    const previous = lowAll('fetched_notes', { account_id: accountId }).map((r) => ({
      title: r.title,
      url: r.url,
      comments: r.comments,
    }))
    for (const row of lowAll('fetched_notes', { account_id: accountId })) {
      lowDelete('fetched_notes', row.id)
    }
    const saved = []
    for (const raw of (notes ?? []).filter((n) => String(n.title ?? '').trim()).slice(0, 20)) {
      const publishedAt =
        parseAbsoluteDateString(raw.publishedDate ?? '') ??
        parsePublishedLabel(raw.publishedLabel ?? '', anchorMs)
      saved.push(
        lowInsert('fetched_notes', {
          account_id: accountId,
          title: String(raw.title).trim(),
          url: String(raw.url ?? '').trim(),
          excerpt: String(raw.excerpt ?? '').trim(),
          likes: raw.likes ?? null,
          collects: raw.collects ?? null,
          shares: raw.shares ?? null,
          comments: raw.comments ?? null,
          published_label: String(raw.publishedLabel ?? '').trim(),
          published_at: publishedAt,
          images_json: JSON.stringify((raw.imageUrls ?? raw.images ?? []).slice(0, 9)),
          fetched_at: anchorMs,
        }),
      )
    }
    return { saved, previous }
  }
  // Muse cleanupUnverifiedFetchedNotes：只保留门禁账号（当前已登录
  // 账号）的已拉笔记；其余账号的 fetched_notes 行与 source='fetched'
  // 的 notes 镜像一并清理，返回 { removedFetchedRows, removedNotes }。
  function cleanupUnverifiedFetchedNotesFor(gateAccountId) {
    let removedFetchedRows = 0
    let removedNotes = 0
    for (const note of lowAll('fetched_notes')) {
      if (note.account_id === gateAccountId) continue
      lowDelete('fetched_notes', note.id)
      removedFetchedRows += 1
    }
    for (const note of lowAll('notes')) {
      if (note.source !== 'fetched') continue
      if (note.account_id === gateAccountId) continue
      for (const snap of lowAll('metric_snapshots', { note_id: note.id })) {
        lowDelete('metric_snapshots', snap.id)
      }
      lowDelete('notes', note.id)
      removedNotes += 1
    }
    return { removedFetchedRows, removedNotes }
  }
  // 详情回填本地换算（Muse startNoteDetailBackfill 第一步，不走浏览器）：
  // 已存相对标签按读取日换算成 published_at；返回 { locallyDated, targets }，
  // targets 为仍缺日期或仍缺 collects/shares/comments 的行（最多 30 篇）。
  function convertPublishedLabels(accountId) {
    const rows = lowAll('fetched_notes', { account_id: accountId }, 'id DESC')
    const libraryRows = lowAll('notes', { account_id: accountId })
    let locallyDated = 0
    for (const r of rows) {
      if (r.published_at != null) continue
      const converted = parsePublishedLabel(r.published_label, r.fetched_at)
      if (converted == null) continue
      lowUpdate('fetched_notes', r.id, { published_at: converted })
      r.published_at = converted
      locallyDated += 1
      const libNote = libraryRows.find(
        (n) =>
          n.source === 'fetched' &&
          (r.url ? n.source_url !== '' && n.source_url === r.url : n.title === r.title),
      )
      if (libNote && libNote.published_at == null) {
        lowUpdate('notes', libNote.id, { published_at: converted })
      }
    }
    const libraryDateFor = (r) => {
      const lib = libraryRows.find(
        (n) =>
          n.source === 'fetched' &&
          (r.url ? n.source_url !== '' && n.source_url === r.url : n.title === r.title),
      )
      return lib?.published_at ?? null
    }
    const targets = rows
      .filter(
        (r) =>
          (r.published_at ?? parsePublishedLabel(r.published_label, r.fetched_at) ?? libraryDateFor(r)) == null ||
          r.collects == null ||
          r.shares == null ||
          r.comments == null,
      )
      .slice(0, 30)
    return { locallyDated, targets }
  }

  // ---- assets ----
  function listAssets() {
    return lowAll('assets', {}, 'id DESC')
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
    return lowUpdate('notes', id, { ...patch, updated_at: nowMs() })
  }
  function deleteNote(id) {
    for (const snap of lowAll('metric_snapshots', { note_id: id })) {
      lowDelete('metric_snapshots', snap.id)
    }
    lowDelete('notes', id)
  }
  // 已拉笔记镜像进笔记库（source='fetched'，status='published'）：
  // saveFetchedNotes 替换时先清该账号旧镜像再重建；saveNoteImages /
  // saveNoteDetails 只就地更新镜像的配图/日期/快照。
  function replaceFetchedNoteMirrors(accountId, savedFetchedNotes) {
    for (const old of lowAll('notes', { account_id: accountId })) {
      if (old.source !== 'fetched') continue
      for (const snap of lowAll('metric_snapshots', { note_id: old.id })) {
        lowDelete('metric_snapshots', snap.id)
      }
      lowDelete('notes', old.id)
    }
    const now = nowMs()
    for (const fn of savedFetchedNotes ?? []) {
      const inserted = lowInsert('notes', {
        account_id: accountId,
        title: String(fn.title ?? '').slice(0, 100),
        body: fn.excerpt ?? '',
        tags_json: '[]',
        image_ids_json: '[]',
        image_captions_json: '[]',
        topic: '',
        fetched_images_json: fn.images_json ?? '[]',
        source: 'fetched',
        source_url: fn.url ?? '',
        status: 'published',
        published_at: fn.published_at ?? null,
        created_at: now,
        updated_at: now,
      })
      if (
        fn.likes != null || fn.collects != null || fn.shares != null || fn.comments != null
      ) {
        lowInsert('metric_snapshots', {
          note_id: inserted.id,
          likes: fn.likes ?? 0,
          collects: fn.collects ?? 0,
          shares: fn.shares ?? 0,
          comments: fn.comments ?? 0,
          captured_at: now,
        })
      }
    }
  }
  function syncFetchedNoteMirrorImages(accountId) {
    for (const fn of lowAll('fetched_notes', { account_id: accountId })) {
      const mirror = lowAll('notes', { account_id: accountId }).find(
        (n) =>
          n.source === 'fetched' &&
          (fn.url ? n.source_url === fn.url : fn.title && n.title === fn.title),
      )
      if (mirror) lowUpdate('notes', mirror.id, { fetched_images_json: fn.images_json ?? '[]' })
    }
  }

  // ---- metric_snapshots ----
  function listSnapshots(noteId) {
    return lowAll('metric_snapshots', { note_id: noteId }, 'id ASC')
  }
  function recordSnapshot(noteId, metrics) {
    return lowInsert('metric_snapshots', {
      note_id: noteId,
      likes: metrics.likes ?? 0,
      collects: metrics.collects ?? 0,
      shares: metrics.shares ?? 0,
      comments: metrics.comments ?? 0,
      captured_at: nowMs(),
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
    for (const n of lowAll('competitor_notifications', { monitored_account_id: id })) {
      lowDelete('competitor_notifications', n.id)
    }
    lowDelete('monitored_accounts', id)
  }
  function countMonitoredNotes(monitoredAccountId) {
    return lowAll('monitored_notes', { monitored_account_id: monitoredAccountId }).length
  }

  // ---- monitored_notes / monitored_snapshots ----
  function listMonitoredNotes(monitoredAccountId) {
    return lowAll('monitored_notes', { monitored_account_id: monitoredAccountId }, 'id DESC')
  }
  function listMonitoredSnapshots(monitoredNoteId) {
    return lowAll('monitored_snapshots', { monitored_note_id: monitoredNoteId }, 'id ASC')
  }
  function recordMonitoredSnapshot(monitoredNoteId, metrics) {
    return lowInsert('monitored_snapshots', {
      monitored_note_id: monitoredNoteId,
      likes: metrics.likes ?? 0,
      collects: metrics.collects ?? 0,
      shares: metrics.shares ?? 0,
      comments: metrics.comments ?? 0,
      captured_at: nowMs(),
    })
  }
  // Muse saveMonitoredAccountFetch：只保留最新 5 篇；已有行就地更新
  // （配图只在本次读到时才替换）；每篇有指标就追加一条快照。
  // 返回 { saved, candidates, hadBaseline } 供竞对通知比对用。
  function applyMonitoredFetch(monitoredAccountId, notes) {
    const now = nowMs()
    const existingNotes = lowAll('monitored_notes', {
      monitored_account_id: monitoredAccountId,
    })
    const preExistingIds = new Set(existingNotes.map((e) => e.id))
    const hadBaseline = preExistingIds.size > 0
    const valid = (notes ?? []).filter((n) => String(n.title ?? '').trim()).slice(0, 5)
    const candidates = []
    let saved = 0
    for (const n of valid) {
      const url = String(n.url ?? '').trim()
      const title = String(n.title ?? '').trim()
      const match = existingNotes.find((e) =>
        url ? e.url !== '' && e.url === url : e.url === '' && e.title === title,
      )
      const hasImages = Array.isArray(n.imageUrls) && n.imageUrls.length > 0
      let noteId
      if (match) {
        noteId = match.id
        lowUpdate('monitored_notes', match.id, {
          title,
          excerpt: String(n.excerpt ?? '').trim(),
          likes: n.likes ?? null,
          collects: n.collects ?? null,
          shares: n.shares ?? null,
          comments: n.comments ?? null,
          published_label: String(n.publishedLabel ?? '').trim(),
          ...(hasImages
            ? { images_json: JSON.stringify(n.imageUrls.slice(0, 9)) }
            : {}),
          fetched_at: now,
        })
      } else {
        const inserted = lowInsert('monitored_notes', {
          monitored_account_id: monitoredAccountId,
          title,
          url,
          excerpt: String(n.excerpt ?? '').trim(),
          likes: n.likes ?? null,
          collects: n.collects ?? null,
          shares: n.shares ?? null,
          comments: n.comments ?? null,
          published_label: String(n.publishedLabel ?? '').trim(),
          images_json: hasImages ? JSON.stringify(n.imageUrls.slice(0, 9)) : '[]',
          fetched_at: now,
        })
        noteId = inserted.id
        existingNotes.push(inserted)
      }
      if (n.likes != null || n.collects != null || n.shares != null || n.comments != null) {
        recordMonitoredSnapshot(noteId, {
          likes: n.likes ?? 0,
          collects: n.collects ?? 0,
          shares: n.shares ?? 0,
          comments: n.comments ?? 0,
        })
      }
      saved += 1
      candidates.push({
        noteId,
        title,
        url,
        likes: n.likes ?? null,
        isNew: !match || !preExistingIds.has(noteId),
        previousLikes: match ? match.likes : null,
      })
    }
    return { saved, candidates, hadBaseline }
  }

  // ---- saveNoteImages：按 url（无 url 按 title）匹配已拉取笔记写回配图 ----
  // Muse：imageUrls 为空的条目跳过（不清空已有配图）。
  function saveNoteImages(accountId, items) {
    let updated = 0
    for (const item of (items ?? []).slice(0, 20)) {
      const url = String(item.url ?? '').trim()
      const title = String(item.title ?? '').trim()
      const images = (item.imageUrls ?? item.images ?? []).slice(0, 9)
      if (images.length === 0) continue
      const existing = findFetchedNote(accountId, url, title)
      if (existing) {
        lowUpdate('fetched_notes', existing.id, { images_json: JSON.stringify(images) })
        updated += 1
      }
    }
    return updated
  }

  // ---- saveNoteDetails：就地回填已有行（不删不重建），追加快照 ----
  function saveNoteDetails(accountId, items, anchorMs = nowMs()) {
    const fetchedRows = lowAll('fetched_notes', { account_id: accountId })
    const libraryRows = lowAll('notes', { account_id: accountId })
    let dated = 0
    let metricsFilled = 0
    for (const item of (items ?? []).slice(0, 30)) {
      const url = String(item.url ?? '').trim()
      const title = String(item.title ?? '').trim()
      const fetched = fetchedRows.find((r) =>
        url ? r.url !== '' && r.url === url : title !== '' && r.title === title,
      )
      if (!fetched) continue
      const readDate =
        parseAbsoluteDateString(item.publishedDate ?? '') ??
        (String(item.publishedLabel ?? '').trim()
          ? parsePublishedLabel(item.publishedLabel, anchorMs)
          : null)
      const merged = {
        likes: item.likes ?? fetched.likes,
        collects: item.collects ?? fetched.collects,
        shares: item.shares ?? fetched.shares,
        comments: item.comments ?? fetched.comments,
      }
      const gotMetric =
        item.likes != null || item.collects != null || item.shares != null || item.comments != null
      // 留资：评论增量（与回填前存量比）先比对再写回。
      noteLeadCommentIncrease(fetched.title, fetched.url, fetched.comments, item.comments)
      lowUpdate('fetched_notes', fetched.id, {
        published_label: String(item.publishedLabel ?? '').trim() || fetched.published_label,
        published_at: readDate ?? fetched.published_at,
        likes: merged.likes,
        collects: merged.collects,
        shares: merged.shares,
        comments: merged.comments,
      })
      if (readDate && fetched.published_at == null) dated += 1
      if (gotMetric) metricsFilled += 1
      const libNote = libraryRows.find(
        (r) =>
          r.source === 'fetched' &&
          (url ? r.source_url !== '' && r.source_url === url : title !== '' && r.title === title),
      )
      if (libNote) {
        if (readDate && libNote.published_at == null) {
          lowUpdate('notes', libNote.id, { published_at: readDate })
        }
        if (gotMetric) {
          lowInsert('metric_snapshots', {
            note_id: libNote.id,
            likes: merged.likes ?? 0,
            collects: merged.collects ?? 0,
            shares: merged.shares ?? 0,
            comments: merged.comments ?? 0,
            captured_at: anchorMs,
          })
        }
      }
    }
    return { dated, metricsFilled }
  }

  // ---- competitor_notifications ----
  function insertCompetitorNotification(values) {
    return lowInsert('competitor_notifications', {
      monitored_account_id: values.monitoredAccountId,
      monitored_note_id: values.monitoredNoteId ?? null,
      type: values.type,
      title: values.title ?? '',
      body: values.body ?? '',
      note_title: values.noteTitle ?? '',
      note_url: values.noteUrl ?? '',
      likes: values.likes ?? null,
      is_read: 0,
      created_at: nowMs(),
    })
  }
  function listCompetitorNotifications(limit = 50) {
    const rows = lowAll('competitor_notifications', {}, 'created_at DESC, id DESC')
    const unreadCount = rows.filter((r) => r.is_read === 0).length
    return { notifications: rows.slice(0, limit), unreadCount }
  }
  function markCompetitorNotificationRead(id) {
    return lowUpdate('competitor_notifications', id, { is_read: 1 })
  }
  function markAllCompetitorNotificationsRead() {
    for (const r of lowAll('competitor_notifications', { is_read: 0 })) {
      lowUpdate('competitor_notifications', r.id, { is_read: 1 })
    }
  }
  // Muse 竞对通知规则：new_note 只在已有基线时报；likes_over_5 为
  // 点赞绝对数 > 5、每篇只报一次。通知失败绝不影响本次拉取保存。
  function generateCompetitorNotifications(monitoredAccountId, candidates, hadBaseline, accountLabel) {
    try {
      const existing = lowAll('competitor_notifications', {
        monitored_account_id: monitoredAccountId,
      })
      const alreadyLikedNotified = new Set(
        existing
          .filter((x) => x.type === 'likes_over_5' && x.monitored_note_id != null)
          .map((x) => x.monitored_note_id),
      )
      const seen = new Set()
      for (const c of candidates ?? []) {
        if (seen.has(c.noteId)) continue
        seen.add(c.noteId)
        if (c.isNew && hadBaseline) {
          insertCompetitorNotification({
            monitoredAccountId,
            monitoredNoteId: c.noteId,
            type: 'new_note',
            title: `「${accountLabel}」发布了新笔记`,
            body: c.title ? `新笔记：${c.title}` : '监测账号发布了一篇新笔记，去竞对监控看看。',
            noteTitle: c.title,
            noteUrl: c.url,
            likes: c.likes,
          })
        }
        if (c.likes != null && c.likes > 5 && !alreadyLikedNotified.has(c.noteId)) {
          insertCompetitorNotification({
            monitoredAccountId,
            monitoredNoteId: c.noteId,
            type: 'likes_over_5',
            title: `「${accountLabel}」有笔记点赞超过 5`,
            body: c.title
              ? `笔记「${c.title}」点赞已达 ${c.likes}（超过 5）。`
              : `一篇笔记点赞已达 ${c.likes}（超过 5）。`,
            noteTitle: c.title,
            noteUrl: c.url,
            likes: c.likes,
          })
          alreadyLikedNotified.add(c.noteId)
        }
      }
    } catch {
      // 通知是附加的：绝不因通知失败而让拉取保存失败。
    }
  }

  // ---- hotspot_state / hotspot_items ----
  function getHotspotState() {
    return lowEnsure('hotspot_state', 1, { updated_at: nowMs() })
  }
  function updateHotspotState(patch) {
    return lowUpdate('hotspot_state', 1, { ...pickColumns('hotspot_state', patch), updated_at: nowMs() })
  }
  function listHotspotItems() {
    return lowAll('hotspot_items', {}, 'fetched_at DESC, id DESC')
  }
  function cleanupHotspotItems(keepMs = 7 * 24 * 3600 * 1000, now = nowMs()) {
    const cutoff = now - keepMs
    let cleaned = 0
    for (const row of lowAll('hotspot_items')) {
      if (row.fetched_at < cutoff) {
        lowDelete('hotspot_items', row.id)
        cleaned += 1
      }
    }
    return cleaned
  }
  // Muse saveHotspotItems：去重键 (source, url)，无 URL 时退为
  // (source, title, keyword)；每轮入库上限 50 条；同批重复只存一行。
  function saveHotspotItems(source, items, now = nowMs()) {
    const incoming = (items ?? []).filter((it) => String(it.title ?? '').trim() !== '').slice(0, 50)
    const existing = lowAll('hotspot_items', { source })
    const keyOf = (url, title, keyword) =>
      String(url ?? '').trim() ? `u|${String(url).trim()}` : `t|${String(title).trim()}|${String(keyword).trim()}`
    const byKey = new Map(existing.map((r) => [keyOf(r.url, r.title, r.keyword), r]))
    let saved = 0
    for (const it of incoming) {
      const key = keyOf(it.url, it.title, it.keyword)
      const prev = byKey.get(key)
      const row = {
        source,
        title: String(it.title).trim(),
        summary: String(it.summary ?? '').trim(),
        url: String(it.url ?? '').trim(),
        keyword: String(it.keyword ?? '').trim(),
        author: String(it.author ?? '').trim(),
        fetched_at: now,
      }
      if (prev) {
        lowUpdate('hotspot_items', prev.id, row)
      } else {
        const inserted = lowInsert('hotspot_items', row)
        byKey.set(key, inserted)
      }
      saved += 1
    }
    return saved
  }

  // ---- lead_state / lead_dm_conversations / lead_notifications ----
  function getLeadState() {
    return lowEnsure('lead_state', 1, { updated_at: nowMs() })
  }
  function updateLeadState(patch) {
    return lowUpdate('lead_state', 1, { ...pickColumns('lead_state', patch), updated_at: nowMs() })
  }
  function listLeadConversations() {
    return lowAll('lead_dm_conversations', {}, 'unread_count DESC, id DESC')
  }
  function insertLeadNotification(values) {
    return lowInsert('lead_notifications', {
      type: values.type,
      title: values.title ?? '',
      body: values.body ?? '',
      sender_name: values.senderName ?? '',
      preview: values.preview ?? '',
      note_title: values.noteTitle ?? '',
      note_url: values.noteUrl ?? '',
      comments: values.comments ?? null,
      comment_delta: values.commentDelta ?? null,
      is_read: 0,
      created_at: nowMs(),
    })
  }
  // 评论增量：两侧都已知且严格增加才报一条；首次读取、任一侧 null、
  // 不变或减少均不报。通知失败绝不影响笔记保存。
  function noteLeadCommentIncrease(noteTitle, noteUrl, previousComments, nextComments) {
    if (previousComments == null || nextComments == null) return
    if (nextComments <= previousComments) return
    const delta = nextComments - previousComments
    try {
      insertLeadNotification({
        type: 'new_comment',
        title: '笔记有新评论',
        body: noteTitle
          ? `笔记「${noteTitle}」新增了 ${delta} 条评论，评论数 ${previousComments} → ${nextComments}。去小红书看看是谁留的言吧。`
          : `一篇笔记新增了 ${delta} 条评论，评论数 ${previousComments} → ${nextComments}。`,
        noteTitle,
        noteUrl,
        comments: nextComments,
        commentDelta: delta,
      })
    } catch {
      // 通知是附加的。
    }
  }
  function listLeadNotifications(limit = 50) {
    const rows = lowAll('lead_notifications', {}, 'created_at DESC, id DESC')
    const unreadCount = rows.filter((r) => r.is_read === 0).length
    return { notifications: rows.slice(0, limit), unreadCount }
  }
  function markLeadNotificationRead(id) {
    return lowUpdate('lead_notifications', id, { is_read: 1 })
  }
  function markAllLeadNotificationsRead() {
    for (const r of lowAll('lead_notifications', { is_read: 0 })) {
      lowUpdate('lead_notifications', r.id, { is_read: 1 })
    }
  }
  // Muse saveLeadDmCheck：按 conversationKey=senderName 去重比对；
  // 新会话（且未读>0）/ 未读增长 / 未读且预览变化 -> new_dm；
  // 首次成功检查只建基线、不报。存量列表整体替换为本次读数。
  function applyLeadDmCheck(incomingRaw, unreadTotal, now = nowMs()) {
    const incoming = (incomingRaw ?? [])
      .map((c) => ({
        senderName: String(c.senderName ?? '').trim(),
        preview: String(c.preview ?? '').trim(),
        unreadCount: c.unreadCount ?? 0,
        timeLabel: String(c.timeLabel ?? '').trim(),
      }))
      .filter((c) => c.senderName !== '')
    const existing = lowAll('lead_dm_conversations')
    const hadBaseline = existing.length > 0
    const byKey = new Map(existing.map((r) => [r.conversation_key, r]))
    let notified = 0
    if (hadBaseline) {
      for (const c of incoming) {
        const prev = byKey.get(c.senderName)
        const isNew = !prev
        const unreadGrew = prev !== undefined && c.unreadCount > prev.unread_count
        const previewChangedWithUnread =
          prev !== undefined && c.unreadCount > 0 && prev.unread_count === 0 && c.preview !== prev.preview
        if (!isNew && !unreadGrew && !previewChangedWithUnread) continue
        if (isNew && c.unreadCount === 0) continue
        try {
          insertLeadNotification({
            type: 'new_dm',
            title: `收到新私信：${c.senderName}`,
            body: c.preview
              ? `「${c.senderName}」发来私信：${c.preview}${c.unreadCount > 1 ? `（共 ${c.unreadCount} 条未读）` : ''}。到小红书里查看和回复吧——工作台只做提醒，不在这里回复。`
              : `「${c.senderName}」有 ${c.unreadCount} 条未读私信（列表没有显示内容摘要）。到小红书里查看和回复吧——工作台只做提醒，不在这里回复。`,
            senderName: c.senderName,
            preview: c.preview,
          })
          notified += 1
        } catch {
          // 通知是附加的。
        }
      }
    }
    for (const row of existing) lowDelete('lead_dm_conversations', row.id)
    for (const c of incoming) {
      lowInsert('lead_dm_conversations', {
        conversation_key: c.senderName,
        sender_name: c.senderName,
        preview: c.preview,
        unread_count: c.unreadCount,
        time_label: c.timeLabel,
        fetched_at: now,
      })
    }
    const unreadSum = incoming.reduce((s, c) => s + c.unreadCount, 0)
    updateLeadState({
      dm_status: 'done',
      dm_task_id: '',
      dm_last_fetched_at: now,
      dm_unread_total: unreadTotal ?? (incoming.length > 0 ? unreadSum : null),
      dm_conversation_count: incoming.length,
    })
    return { saved: incoming.length, notified, hadBaseline }
  }

  // ---- shared_session_requests ----
  const SHARED_KINDS = [
    'account_info', 'account_notes', 'note_images', 'note_details',
    'monitored_account', 'lead_dm', 'hotspot_xhs', 'publish_note',
  ]
  function sameSharedTarget(row, t) {
    return (
      (row.account_id ?? null) === (t.accountId ?? null) &&
      (row.monitored_account_id ?? null) === (t.monitoredAccountId ?? null) &&
      (row.note_id ?? null) === (t.noteId ?? null)
    )
  }
  function upsertSharedRequest(kind, t = {}) {
    if (!SHARED_KINDS.includes(kind)) return 0
    const now = nowMs()
    const pending = lowAll('shared_session_requests', { status: 'pending' })
    const existing = pending.find((r) => r.kind === kind && sameSharedTarget(r, t))
    if (existing) {
      const patch = { updated_at: now }
      if (t.message) patch.message = t.message
      if (t.payload !== undefined) patch.payload = t.payload
      lowUpdate('shared_session_requests', existing.id, patch)
      return existing.id
    }
    const inserted = lowInsert('shared_session_requests', {
      kind,
      account_id: t.accountId ?? null,
      monitored_account_id: t.monitoredAccountId ?? null,
      note_id: t.noteId ?? null,
      payload: t.payload ?? '',
      status: 'pending',
      message: t.message ?? '',
      result_message: '',
      created_at: now,
      updated_at: now,
      fulfilled_at: null,
    })
    return inserted.id
  }
  function fulfillSharedRequests(kind, t, resultMessage) {
    try {
      const now = nowMs()
      for (const row of lowAll('shared_session_requests', { status: 'pending' })) {
        if (row.kind !== kind || !sameSharedTarget(row, t)) continue
        lowUpdate('shared_session_requests', row.id, {
          status: 'fulfilled',
          fulfilled_at: now,
          updated_at: now,
          result_message: resultMessage ?? '',
        })
      }
    } catch {
      // 队列是记账：绝不因此让保存失败。
    }
  }
  function listSharedSessionRequests() {
    const rows = lowAll('shared_session_requests', {}, 'id DESC')
    const pending = rows.filter((r) => r.status === 'pending')
    const recentDone = rows.filter((r) => r.status !== 'pending').slice(0, 20)
    return { requests: [...pending, ...recentDone], pendingCount: pending.length }
  }
  function cancelSharedSessionRequest(id) {
    const row = lowGet('shared_session_requests', id)
    if (!row) return { found: false, cancelled: false }
    if (row.status !== 'pending') return { found: true, cancelled: false }
    lowUpdate('shared_session_requests', id, {
      status: 'cancelled',
      updated_at: nowMs(),
      result_message: '已在工作台里取消。',
    })
    return { found: true, cancelled: true }
  }
  function countPendingSharedRequests() {
    return lowAll('shared_session_requests', { status: 'pending' }).length
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
    getHotspotConfig,
    listAccounts,
    getAccount,
    getAccountByXhsId,
    getPrimaryAccount,
    getGateAccount,
    writeGate,
    seedGateFromVerified,
    upsertAccount,
    updateAccount,
    setMonitoredAccount,
    deleteAccount,
    countFetchedNotes,
    listFetchedNotes,
    findFetchedNote,
    reassignFetchedNotes,
    replaceFetchedNotes,
    cleanupUnverifiedFetchedNotesFor,
    convertPublishedLabels,
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
    replaceFetchedNoteMirrors,
    syncFetchedNoteMirrorImages,
    listSnapshots,
    recordSnapshot,
    listMonitoredAccounts,
    getMonitoredAccount,
    getMonitoredAccountByHomepage,
    upsertMonitoredAccount,
    updateMonitoredAccount,
    deleteMonitoredAccount,
    countMonitoredNotes,
    listMonitoredNotes,
    listMonitoredSnapshots,
    recordMonitoredSnapshot,
    applyMonitoredFetch,
    saveNoteImages,
    saveNoteDetails,
    insertCompetitorNotification,
    listCompetitorNotifications,
    markCompetitorNotificationRead,
    markAllCompetitorNotificationsRead,
    generateCompetitorNotifications,
    getHotspotState,
    updateHotspotState,
    listHotspotItems,
    cleanupHotspotItems,
    saveHotspotItems,
    getLeadState,
    updateLeadState,
    listLeadConversations,
    insertLeadNotification,
    noteLeadCommentIncrease,
    listLeadNotifications,
    markLeadNotificationRead,
    markAllLeadNotificationsRead,
    applyLeadDmCheck,
    upsertSharedRequest,
    fulfillSharedRequests,
    listSharedSessionRequests,
    cancelSharedSessionRequest,
    countPendingSharedRequests,
    close,
  }
}
