// 统一登录门禁：全项目唯一判定入口。
//
// 规则（分支顺序，先命中者胜，不可打乱）：
//   输入：login_session 单行（id=1）+ 主账号
//     primary = session.accountId 匹配的账号
//            ?? 首个 loginStatus='verified' 的账号
//            ?? 首账号（accounts 按 monitored DESC, id ASC 排序）
//            ?? null
//   recordedValid = primary && primary.loginStatus === 'verified'
//   infoFetching  = primary && (infoFetchStatus === 'fetching' || loginStatus === 'verifying')
//   lastVerifiedAt = session.lastVerifiedAt ?? primary.loginVerifiedAt ?? null
//   stale = lastVerifiedAt ? 现在 - lastVerifiedAt > 24 小时 : false
//   (1) !primary → needs_scan
//   (2) session.browserState === 'logged_out' && session.gateState === 'expired' → expired
//       （browserState='logged_out' 单独出现不触发 expired，必须同时 gateState='expired'）
//   (3) recordedValid && !stale → valid
//   (4) handshakeStatus === 'checking' || infoFetching → checking
//   (5) recordedValid && stale → checking
//   (6) gateState === 'needs_scan' || primary.loginStatus === 'failed' → needs_scan
//   (7) 其余 → unknown
//
// 关键口径：
// - inconclusive（无法确定结果）的握手绝不把门禁翻成 expired；
// - 分支 (3) 优先于 (4)：已记录有效的登录在握手进行中时仍保持 valid；
// - 不要把 accounts.loginStatus / loginVerifiedAt 当作门禁直读，
//   它们只是历史镜像——所有服务端门禁只调 resolveLoginGate。
// - 唯一写 gate=valid 的地方：成功读账号信息、结论性 logged_in 的握手回写；
//   唯一写 gate=expired 的地方：结论性 logged_out 的握手回写。
//
// 时间一律走注入的 clock，不直接读 Date.now()。

export const GATE_STATES = ['unknown', 'checking', 'valid', 'expired', 'needs_scan']

const STALE_MS = 24 * 3600 * 1000

function toMs(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function gateMessage(state, nickname) {
  const who = nickname ? `（${nickname}）` : ''
  switch (state) {
    case 'valid':
      return `已登录小红书${who}，可以拉取数据。`
    case 'expired':
      return '登录已过期，请重新扫码登录小红书。'
    case 'needs_scan':
      return '尚未登录小红书，请扫码登录后再操作。'
    case 'checking':
      return '正在确认小红书登录状态，请稍候。'
    default:
      return '小红书登录状态未知，请扫码登录确认。'
  }
}

/**
 * 解析统一登录门禁。
 * @param {object} store createStore 返回的存储对象
 * @param {object} clock 注入的时钟 { now() }
 * @returns gate 对象
 */
export function resolveLoginGate(store, clock) {
  const session = store.getLoginSession()
  const accounts = store.listAccounts()
  const sorted = [...accounts].sort(
    (a, b) => (b.monitored || 0) - (a.monitored || 0) || a.id - b.id,
  )

  let primary = null
  if (session.account_id != null) {
    primary = sorted.find((a) => a.id === session.account_id) ?? null
  }
  if (!primary) primary = sorted.find((a) => a.login_status === 'verified') ?? null
  if (!primary) primary = sorted[0] ?? null

  const recordedValid = Boolean(primary && primary.login_status === 'verified')
  const infoFetching = Boolean(
    primary &&
      (primary.info_fetch_status === 'fetching' || primary.login_status === 'verifying'),
  )
  const lastVerifiedAt =
    toMs(session.last_verified_at) ?? toMs(primary?.login_verified_at) ?? null
  const stale = lastVerifiedAt != null ? clock.now() - lastVerifiedAt > STALE_MS : false

  let state
  if (!primary) {
    state = 'needs_scan'
  } else if (session.browser_state === 'logged_out' && session.gate_state === 'expired') {
    state = 'expired'
  } else if (recordedValid && !stale) {
    state = 'valid'
  } else if (session.handshake_status === 'checking' || infoFetching) {
    state = 'checking'
  } else if (recordedValid && stale) {
    state = 'checking'
  } else if (session.gate_state === 'needs_scan' || primary.login_status === 'failed') {
    state = 'needs_scan'
  } else {
    state = 'unknown'
  }

  const isLoggedIn = state === 'valid'
  const nickname = primary?.nickname ?? null

  return {
    accountId: primary?.id ?? null,
    state,
    recordedStatus: primary ? primary.login_status : 'none',
    browserState: session.browser_state,
    handshakeStatus: session.handshake_status,
    handshakeMessage: session.handshake_message || '',
    lastHandshakeAt: toMs(session.last_handshake_at),
    lastVerifiedAt,
    qrAutoOpenedAt: toMs(session.qr_auto_opened_at),
    qrLastOpenedAt: toMs(session.qr_last_opened_at),
    canFetch: isLoggedIn,
    isLoggedIn,
    needsQrLogin: state === 'expired' || state === 'needs_scan',
    nickname,
    message: gateMessage(state, nickname),
  }
}
