// 纯函数调度器：握手与热点 tick 的到期判断。
// 与任何存储 / 网络无关，便于单测。

export const HANDSHAKE_INTERVAL_MS = 60 * 1000
export const HOTSPOT_TICK_INTERVAL_MS = 15 * 60 * 1000
export const HOTSPOT_X_INTERVAL_MS = 12 * 3600 * 1000
export const HOTSPOT_KEEP_MS = 7 * 24 * 3600 * 1000
export const HOTSPOT_MAX_ITEMS_PER_RUN = 50

function toMs(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/**
 * 距上次运行是否已满 60 秒（到期需要握手）。
 * lastRunAt 为 null / 未知时返回 true（需要立即握手一次）。
 */
export function dueHandshake(lastRunAt, now = Date.now()) {
  const last = toMs(lastRunAt)
  if (last == null) return true
  return now - last >= HANDSHAKE_INTERVAL_MS
}

/** 下一次握手时间（毫秒时间戳）。lastRunAt 为空时按当前时间起算。 */
export function nextRunAt(lastRunAt, now = Date.now()) {
  const last = toMs(lastRunAt)
  return (last ?? now) + HANDSHAKE_INTERVAL_MS
}

/**
 * 热点 tick 到期判断（Muse runHotspotSearchTick，actions.ts:6298–6340）：
 * - 小红书源：enabled 且有关键词、且不在 fetching 中、且
 *   now - xhsLastAttemptAt >= intervalHours（非法值回落 6 小时）；
 *   lastAttemptAt 为 null 时视为到期（立即检索一次）。
 * - X 源：不在 fetching 中、且 now - xLastAttemptAt >= 12 小时（固定，
 *   与用户间隔无关）；lastAttemptAt 为 null 时视为到期。
 * config: { keywords, intervalHours, enabled }；state: hotspot_state 行。
 */
export function dueHotspotSearch(state, config, now = Date.now()) {
  const keywords = Array.isArray(config?.keywords) ? config.keywords : []
  const intervalHours =
    typeof config?.intervalHours === 'number' && config.intervalHours >= 1 && config.intervalHours <= 24
      ? config.intervalHours
      : 6
  const enabled = config?.enabled !== false
  const xhsLastAttemptAt = toMs(state?.xhs_last_attempt_at)
  const xLastAttemptAt = toMs(state?.x_last_attempt_at)
  const xhsDue =
    enabled &&
    keywords.length > 0 &&
    state?.xhs_status !== 'fetching' &&
    (xhsLastAttemptAt == null || now - xhsLastAttemptAt >= intervalHours * 3600 * 1000)
  const xDue =
    enabled &&
    keywords.length > 0 &&
    state?.x_status !== 'fetching' &&
    (xLastAttemptAt == null || now - xLastAttemptAt >= HOTSPOT_X_INTERVAL_MS)
  return { xhsDue: Boolean(xhsDue), xDue: Boolean(xDue) }
}

/** 热点源下一次到期时间（毫秒时间戳），供状态卡 nextDueAt 用。 */
export function nextHotspotDueAt(lastAttemptAt, intervalMs, now = Date.now()) {
  const last = toMs(lastAttemptAt)
  if (last == null) return now
  const due = last + intervalMs
  return due < now ? now : due
}
