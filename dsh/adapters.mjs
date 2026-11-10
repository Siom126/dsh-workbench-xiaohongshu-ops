// 宿主适配层：把宿主能力转成 core 需要的注入依赖。
// 只做“宿主实现”，不含任何业务规则；表结构与 SQL 语义由 core 的 store 定义。
//
// createNodeStorage(root):
//   node:sqlite 优先；不可用时降级为同目录 JSON 文件存储。
//   文件名与文件格式与旧版 createStore(root) 完全一致，
//   已有数据文件可直接沿用：
//     SQLite：<root>/xiaohongshu-ops.sqlite（WAL 模式），blob 在 <root>/blobs/
//     JSON：  <root>/xiaohongshu-ops.json（{表名: 行数组}，两空格缩进），blob 同上
//   存储接口：
//     exec(sql) / all(table, where, orderBy) / get(table, id) /
//     insert(table, row) / update(table, id, patch) / delete(table, id) /
//     writeBlob(blobKey, buffer) -> blob 文件完整路径 /
//     readBlob(blobKey) -> Buffer|null / deleteBlob(blobKey) / close()
// createClock(): 时间/定时抽象 { now, nowIso, setInterval, clearInterval }
// createLogger(): 日志抽象 { info, warn, error }

import fs from 'node:fs'
import path from 'node:path'
import { COLUMNS, TIME_COLUMNS } from '../packages/core/store.mjs'

// ---- v0.2.0 数据迁移（只针对 v0.1.0 的旧库，空库无操作） ----
// v0.1.0 全库时间用 ISO 文本、另有 8 个 Muse 没有的列
// （accounts/monitored_accounts 的 avatar_url、fetched_count，
// fetched_notes/monitored_notes 的 created_at，
// metric_snapshots/monitored_snapshots 的 recorded_at），
// 且门禁存在独立的 login_session 表。v0.2.0 以 Muse 为准统一为
// 毫秒时间戳 INTEGER：
//   1. 旧表缺的列用 ALTER TABLE ADD COLUMN 补上；
//   2. ISO 文本时间值用 strftime 转成毫秒数（TEXT 亲和性的旧列
//      仍会把数字存成文本，读时再由 normalizeRow 转回数字）；
//   3. 多余列用 ALTER TABLE DROP COLUMN 删掉；
//   4. login_session 行按 Muse 0016 口径并入对应账号行
//      （仅当 accounts.gate_updated_at <= login_session.updated_at
//      时才覆盖，避免回退更新的门禁写），然后 DROP TABLE。
// JSON 后端在构造时做同样的归一化（见 normalizeJsonRow）。
function newColumnSql(col) {
  // 新增列一律可空（或带默认值），保证 ALTER 对已有行安全。
  if (TIME_COLUMNS && Object.values(TIME_COLUMNS).flat().includes(col)) return `${col} INTEGER`
  if (
    col.endsWith('_count') || col.endsWith('_total') || col.endsWith('_done') ||
    col === 'monitored' || col === 'is_read' || col === 'hotspot_enabled' ||
    col === 'hotspot_interval_hours' || col === 'size_bytes' ||
    col === 'likes' || col === 'collects' || col === 'shares' || col === 'comments' ||
    col === 'comment_delta' || col === 'unread_count' || col === 'dm_unread_total' ||
    col === 'dm_conversation_count'
  ) return `${col} INTEGER NOT NULL DEFAULT 0`
  return `${col} TEXT NOT NULL DEFAULT ''`
}

function normalizeRow(table, row) {
  if (!row || typeof row !== 'object') return row
  const out = { ...row }
  const timeCols = TIME_COLUMNS[table] ?? []
  for (const col of timeCols) {
    const v = out[col]
    if (typeof v === 'string') {
      if (/^-?\d+$/.test(v.trim())) out[col] = Number(v.trim())
      else {
        const parsed = Date.parse(v)
        out[col] = Number.isNaN(parsed) ? null : parsed
      }
    }
  }
  return out
}

function normalizeJsonRow(table, row) {
  const out = {}
  for (const col of COLUMNS[table]) {
    if (row[col] !== undefined) out[col] = row[col]
  }
  return normalizeRow(table, out)
}

let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

const BLOB_SUBDIR = 'blobs'
const SQLITE_FILE = 'xiaohongshu-ops.sqlite'
const JSON_FILE = 'xiaohongshu-ops.json'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function blobFileName(blobKey) {
  return String(blobKey).replace(/[\\/]/g, '_')
}

// ---- JSON 后端（与旧版 createStore 的 JSON 分支逐字一致） ----
class JsonBackend {
  constructor(root) {
    this.root = root
    ensureDir(root)
    this.jsonPath = path.join(root, JSON_FILE)
    this.blobDir = path.join(root, BLOB_SUBDIR)
    ensureDir(this.blobDir)
    this.tables = {}
    for (const table of Object.keys(COLUMNS)) this.tables[table] = []
    if (fs.existsSync(this.jsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'))
        for (const table of Object.keys(COLUMNS)) {
          this.tables[table] = Array.isArray(parsed[table])
            ? parsed[table].map((row) => normalizeJsonRow(table, row))
            : []
        }
        // v0.2.0 迁移：旧 login_session 行并入 accounts 后删表
        //（0016 口径：仅当账号行 gate_updated_at <= 旧行 updated_at 时覆盖）。
        const legacy = Array.isArray(parsed.login_session) ? parsed.login_session[0] : null
        if (legacy) {
          const target =
            this.tables.accounts.find((a) => a.id === legacy.account_id) ??
            this.tables.accounts[0] ??
            null
          if (target) {
            const oldUpdated = typeof legacy.updated_at === 'number' ? legacy.updated_at : 0
            if ((target.gate_updated_at ?? 0) <= oldUpdated) {
              Object.assign(target, {
                gate_state: legacy.gate_state ?? target.gate_state,
                gate_browser_state: legacy.browser_state ?? target.gate_browser_state,
                gate_handshake_status: legacy.handshake_status ?? target.gate_handshake_status,
                gate_handshake_message: legacy.handshake_message ?? '',
                gate_handshake_task_id: legacy.handshake_task_id ?? '',
                gate_last_handshake_at:
                  typeof legacy.last_handshake_at === 'number'
                    ? legacy.last_handshake_at
                    : legacy.last_handshake_at
                      ? Date.parse(legacy.last_handshake_at)
                      : null,
                gate_last_verified_at:
                  typeof legacy.last_verified_at === 'number'
                    ? legacy.last_verified_at
                    : legacy.last_verified_at
                      ? Date.parse(legacy.last_verified_at)
                      : null,
                gate_qr_auto_opened_at: legacy.qr_auto_opened_at ?? null,
                gate_qr_last_opened_at: legacy.qr_last_opened_at ?? null,
                gate_updated_at: oldUpdated,
              })
            }
          }
          this.persist()
        }
      } catch {
        // 解析失败时从空开始
      }
    }
  }

  persist() {
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.tables, null, 2), 'utf8')
  }

  exec() {
    // DDL 是 no-op（表已在构造时按 COLUMNS 初始化）。
  }

  all(table, where = {}, orderBy = 'id ASC') {
    const rows = this.tables[table].filter((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    )
    const [field, dir] = orderBy.split(' ')
    return [...rows].sort((a, b) =>
      dir === 'DESC' ? (b[field] ?? 0) - (a[field] ?? 0) : (a[field] ?? 0) - (b[field] ?? 0),
    )
  }

  get(table, id) {
    if (id == null) return null
    return this.tables[table].find((row) => row.id === id) ?? null
  }

  insert(table, row) {
    const maxId = this.tables[table].reduce((m, r) => Math.max(m, r.id || 0), 0)
    const full = { ...row, id: row.id ?? maxId + 1 }
    this.tables[table].push(full)
    this.persist()
    return { ...full }
  }

  update(table, id, patch) {
    const row = this.tables[table].find((r) => r.id === id)
    if (!row) return null
    Object.assign(row, patch)
    this.persist()
    return { ...row }
  }

  delete(table, id) {
    this.tables[table] = this.tables[table].filter((r) => r.id !== id)
    this.persist()
  }

  writeBlob(blobKey, buffer) {
    const file = path.join(this.blobDir, blobFileName(blobKey))
    fs.writeFileSync(file, buffer)
    return file
  }

  readBlob(blobKey) {
    const file = path.join(this.blobDir, blobFileName(blobKey))
    return fs.existsSync(file) ? fs.readFileSync(file) : null
  }

  deleteBlob(blobKey) {
    const file = path.join(this.blobDir, blobFileName(blobKey))
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  }

  close() {
    // JSON 后端每次写操作都已落盘，关闭无事可做。
  }
}

// ---- SQLite 后端（与旧版 createStore 的 SQLite 分支逐字一致） ----
class SqliteBackend {
  constructor(root) {
    ensureDir(root)
    this.db = new DatabaseSync(path.join(root, SQLITE_FILE))
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.blobDir = path.join(root, BLOB_SUBDIR)
    ensureDir(this.blobDir)
    this.closed = false
    this.migrated = false
  }

  // v0.2.0 迁移（见文件头注释）：在第一次执行 DDL 前跑一次。
  migrateExisting() {
    if (this.migrated) return
    this.migrated = true
    try {
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
      // 1. 补列 / 删多余列（login_session 除外，见第 3 步）。
      for (const table of Object.keys(COLUMNS)) {
        if (!tables.includes(table)) continue
        const info = this.db.prepare(`PRAGMA table_info(${table})`).all()
        const existing = new Set(info.map((c) => c.name))
        for (const col of COLUMNS[table]) {
          if (col === 'id' || existing.has(col)) continue
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${newColumnSql(col)}`)
        }
        for (const col of info.map((c) => c.name)) {
          if (col === 'id' || COLUMNS[table].includes(col)) continue
          try {
            this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`)
          } catch {
            // 旧 SQLite 不支持 DROP COLUMN 时保留该列（业务层忽略多余列）。
          }
        }
      }
      // 2. ISO 文本时间 -> 毫秒数（只转含 'T' 的 ISO 文本值）。
      for (const table of Object.keys(COLUMNS)) {
        if (!tables.includes(table)) continue
        for (const col of TIME_COLUMNS[table] ?? []) {
          try {
            this.db.exec(
              `UPDATE ${table} SET ${col} = CAST(strftime('%s', ${col}) * 1000 AS INTEGER) ` +
                `WHERE typeof(${col}) = 'text' AND ${col} LIKE '%T%'`,
            )
          } catch {
            // 该列不存在时跳过。
          }
        }
      }
      // 3. login_session 行并入 accounts（0016 口径）后删表。
      if (tables.includes('login_session')) {
        try {
          const legacy = this.db.prepare('SELECT * FROM login_session WHERE id = 1').get()
          if (legacy) {
            const targetId = legacy.account_id ?? null
            const target = targetId
              ? this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(targetId)
              : this.db.prepare('SELECT * FROM accounts ORDER BY id ASC LIMIT 1').get()
            if (target && (target.gate_updated_at ?? 0) <= (legacy.updated_at ?? 0)) {
              this.db
                .prepare(
                  `UPDATE accounts SET gate_state = ?, gate_browser_state = ?, ` +
                    `gate_handshake_status = ?, gate_handshake_message = ?, ` +
                    `gate_handshake_task_id = ?, gate_last_handshake_at = ?, ` +
                    `gate_last_verified_at = ?, gate_qr_auto_opened_at = ?, ` +
                    `gate_qr_last_opened_at = ?, gate_updated_at = ? WHERE id = ?`,
                )
                .run(
                  legacy.gate_state ?? target.gate_state,
                  legacy.browser_state ?? target.gate_browser_state,
                  legacy.handshake_status ?? target.gate_handshake_status,
                  legacy.handshake_message ?? '',
                  legacy.handshake_task_id ?? '',
                  legacy.last_handshake_at ?? null,
                  legacy.last_verified_at ?? null,
                  legacy.qr_auto_opened_at ?? null,
                  legacy.qr_last_opened_at ?? null,
                  legacy.updated_at ?? 0,
                  target.id,
                )
            }
          }
          this.db.exec('DROP TABLE IF EXISTS login_session')
        } catch {
          // 迁移失败不阻塞启动（门禁由 accounts 行推导，缺失即 unknown）。
        }
      }
    } catch {
      // 迁移是尽力而为：失败时新 DDL 仍会建缺失的表，旧数据按原样读。
    }
  }

  exec(sql) {
    this.migrateExisting()
    this.db.exec(sql)
  }

  all(table, where = {}, orderBy = 'id ASC') {
    const keys = Object.keys(where)
    const sql =
      `SELECT * FROM ${table}` +
      (keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : '') +
      ` ORDER BY ${orderBy}`
    return this.db
      .prepare(sql)
      .all(...keys.map((k) => where[k]))
      .map((row) => normalizeRow(table, row))
  }

  get(table, id) {
    if (id == null) return null
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null
    return normalizeRow(table, row)
  }

  insert(table, row) {
    const cols = Object.keys(row)
    const placeholders = cols.map(() => '?').join(', ')
    const info = this.db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
      .run(...cols.map((c) => row[c]))
    return this.get(table, Number(info.lastInsertRowid))
  }

  update(table, id, patch) {
    const cols = Object.keys(patch)
    if (cols.length === 0) return this.get(table, id)
    this.db
      .prepare(
        `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      )
      .run(...cols.map((c) => patch[c]), id)
    return this.get(table, id)
  }

  delete(table, id) {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
  }

  writeBlob(blobKey, buffer) {
    const file = path.join(this.blobDir, blobFileName(blobKey))
    fs.writeFileSync(file, buffer)
    return file
  }

  readBlob(blobKey) {
    const file = path.join(this.blobDir, blobFileName(blobKey))
    return fs.existsSync(file) ? fs.readFileSync(file) : null
  }

  deleteBlob(blobKey) {
    const file = path.join(this.blobDir, blobFileName(blobKey))
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  }

  close() {
    if (this.closed || !this.db) return
    try {
      this.db.close()
    } catch {
      // 已关闭时忽略
    }
    this.db = null
    this.closed = true
  }
}

// ---- 工厂 ----
export function createNodeStorage(root) {
  ensureDir(root)
  if (DatabaseSync) {
    try {
      return new SqliteBackend(root)
    } catch {
      // SQLite 不可用时降级为 JSON 存储
    }
  }
  return new JsonBackend(root)
}

export function createClock() {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  }
}

export function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  }
}
