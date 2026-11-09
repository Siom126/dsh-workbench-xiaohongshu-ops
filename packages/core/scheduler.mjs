// 纯函数调度器：握手定时判断。
// 与任何存储 / 网络无关，便于单测。

export const HANDSHAKE_INTERVAL_MS = 60 * 1000

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
