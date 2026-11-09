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
import { COLUMNS } from '../packages/core/store.mjs'

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
          this.tables[table] = Array.isArray(parsed[table]) ? parsed[table] : []
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
  }

  exec(sql) {
    this.db.exec(sql)
  }

  all(table, where = {}, orderBy = 'id ASC') {
    const keys = Object.keys(where)
    const sql =
      `SELECT * FROM ${table}` +
      (keys.length ? ` WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}` : '') +
      ` ORDER BY ${orderBy}`
    return this.db.prepare(sql).all(...keys.map((k) => where[k]))
  }

  get(table, id) {
    if (id == null) return null
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null
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
