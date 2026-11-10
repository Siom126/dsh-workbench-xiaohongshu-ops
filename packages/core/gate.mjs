// 统一登录门禁：全项目唯一判定入口（照抄 Muse resolveLoginGate，
// server/src/actions.ts:958–1155；唯一存储是门禁账号行的 gate_* /
// gate_shared_* 列，login_session 表已删除）。
//
// 结论是三态 verdict（logged_in / logged_out / unknown），带原因与
// 最近确认时间；isLoggedIn / canFetch / needsQrLogin 是 verdict 的
// 纯函数，永不矛盾。state 只是由 verdict 派生的遗留别名。
//
// 判定分支（按顺序，先命中者胜）：
//   (1) 无 primary -> logged_out（“还没有绑定账号”）
//   (2) conclusive 登出：browserState='logged_out' 且 gateState='expired'，
//       且该登出结论不 older 于最近一次登录确认 -> logged_out
//   (3) 有记录确认且未过期（24 小时内）-> logged_in
//       （握手进行中 / 不确定 / 超时都不翻转此结论）
//   (4) 有记录确认但超 24 小时 -> unknown
//   (5) 从未确认过且 loginStatus='failed' -> logged_out
//   (6) 握手超时 -> unknown（“任务无回写”）
//   (7) 检查在途 -> unknown
//   (8) 其余 -> unknown
//
// lastConfirmedAt = 任务浏览器确认时间（gateLastVerifiedAt ??
// loginVerifiedAt）与共用会话确认时间（gateSharedAt，仅当
// gateSharedState='logged_in'）二者取最新者。
//
// 硬超时（两个 10 分钟）：
// - HANDSHAKE_TIMEOUT_MS：handshakeStatus='checking' 且
//   now - lastHandshakeAt > 10 分钟 -> 派生 handshakeStatus='unknown'、
//   handshakeTimedOut=true；超时握手不改记录态、不开扫码页、不怪用户。
// - INFO_FETCH_TIMEOUT_MS：infoFetchStatus='fetching'（或
//   loginStatus='verifying'）且 infoFetchStartedAt 存在且
//   now - infoFetchStartedAt > 10 分钟 -> 派生 infoFetchTimedOut=true、
//   infoFetching=false；超时读取不再被当作“在途”，不得再挡住用户
//   主动点的扫码登录与 60 秒握手。
// - QR_WAIT_MS = 5 分钟：qrWaiting = infoFetching && qrLastOpenedAt != null；
//   qrWaitDeadlineAt = qrLastOpenedAt + 5 分钟。
//
// 共用会话优先：任务浏览器的 logged_out 握手结论推翻不了更新的
// 共用会话登录确认（分支 2 的时间比较）；loginSource 在已登录时取
// 确认最新的一方（shared_browser / task_browser），未登录时为 'none'。
// sharedChannelActive(gate)：已登录且来源为共用会话且任务浏览器
// conclusively 未登录时，登录依赖型工作不派任务浏览器任务，改为
// 登记共用会话请求。
//
// “用户未完成扫码”文案只出现在用户自己点开的扫码等待里；后台
// 尝试超时一律写“后台登录确认超时，未能确认登录态”。
//
// 时间一律走注入的 clock，不直接读 Date.now()。返回的各时间字段
// 均为 ISO 字符串或 null（与 Muse gateToShape 一致）。

export const GATE_STATES = ['unknown', 'checking', 'valid', 'expired', 'needs_scan']

export const HANDSHAKE_TIMEOUT_MS = 10 * 60 * 1000
export const INFO_FETCH_TIMEOUT_MS = 10 * 60 * 1000
export const QR_WAIT_MS = 5 * 60 * 1000
export const STALE_MS = 24 * 3600 * 1000

function toMs(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function toIso(ms) {
  if (ms == null) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * 解析统一登录门禁。
 * @param {object} store createStore 返回的存储对象
 * @param {object} clock 注入的时钟 { now() }
 * @returns loginGateShape（Muse gateToShape 的全部字段，时间均为 ISO 字符串）
 */
export function resolveLoginGate(store, clock) {
  // 懒种子：门禁列全是默认值、但记录态已 verified 的账号，种子为 valid。
  // （与 Muse ensureLoginSession 同口径；无账号时什么都不做。）
  try {
    store.seedGateFromVerified()
  } catch {
    // 种子失败不影响门禁判定。
  }
  const gateAccount = store.getGateAccount()
  const accounts = store.listAccounts()
  const sorted = [...accounts].sort(
    (a, b) => (b.monitored || 0) - (a.monitored || 0) || a.id - b.id,
  )
  // primary：门禁账号行 -> 首个 verified -> 首行（与 Muse 一致）。
  const primary =
    (gateAccount ? sorted.find((a) => a.id === gateAccount.id) ?? null : null) ??
    sorted.find((a) => a.login_status === 'verified') ??
    sorted[0] ??
    null

  const now = clock.now()
  const session = gateAccount ?? {
    gate_state: 'unknown',
    gate_last_verified_at: null,
    gate_last_handshake_at: null,
    gate_handshake_status: 'idle',
    gate_handshake_task_id: '',
    gate_handshake_message: '',
    gate_browser_state: 'unknown',
    gate_qr_auto_opened_at: null,
    gate_qr_last_opened_at: null,
    gate_shared_state: 'unknown',
    gate_shared_at: null,
    gate_shared_message: '',
    gate_shared_nickname: '',
    gate_shared_xhs_id: '',
  }

  // ---- info-fetch 超时（读时派生） ----
  const infoFetchTimedOut =
    Boolean(primary) &&
    (primary.info_fetch_status === 'fetching' || primary.login_status === 'verifying') &&
    primary.info_fetch_started_at != null &&
    now - toMs(primary.info_fetch_started_at) > INFO_FETCH_TIMEOUT_MS
  const infoFetching =
    Boolean(primary) &&
    (primary.info_fetch_status === 'fetching' || primary.login_status === 'verifying') &&
    !infoFetchTimedOut

  // ---- 事实 ----
  const taskConfirmedAt = toMs(session.gate_last_verified_at) ?? toMs(primary?.login_verified_at) ?? null
  const sharedConfirmedAt = session.gate_shared_state === 'logged_in' ? toMs(session.gate_shared_at) : null
  const lastConfirmedAt =
    taskConfirmedAt != null && sharedConfirmedAt != null
      ? Math.max(taskConfirmedAt, sharedConfirmedAt)
      : (taskConfirmedAt ?? sharedConfirmedAt)
  const recordedConfirmed = lastConfirmedAt != null || primary?.login_status === 'verified'
  const stale = lastConfirmedAt != null ? now - lastConfirmedAt > STALE_MS : false
  const lastHandshakeAt = toMs(session.gate_last_handshake_at)
  const conclusiveLogout =
    session.gate_browser_state === 'logged_out' &&
    session.gate_state === 'expired' &&
    (lastConfirmedAt == null ||
      lastHandshakeAt == null ||
      lastHandshakeAt >= lastConfirmedAt)
  const handshakeTimedOut =
    session.gate_handshake_status === 'checking' &&
    lastHandshakeAt != null &&
    now - lastHandshakeAt > HANDSHAKE_TIMEOUT_MS
  const effectiveHandshakeStatus = handshakeTimedOut ? 'unknown' : session.gate_handshake_status
  const checkInFlight =
    (session.gate_handshake_status === 'checking' && !handshakeTimedOut) || infoFetching

  // ---- verdict（按顺序，先命中者胜） ----
  let verdict
  let message
  if (!primary) {
    verdict = 'logged_out'
    message = '未登录：还没有绑定账号。点「+ 绑定新账号」扫码登录，登录后会自动读取账号信息成为主账号。'
  } else if (conclusiveLogout) {
    verdict = 'logged_out'
    message =
      session.gate_shared_state === 'logged_out'
        ? '未登录：共用会话（Muse 聊天里你能看到的浏览器）和工作台自己的浏览器最近都确认未登录小红书。在 Muse 聊天里让 Muse 打开小红书登录页扫码，或点「打开浏览器扫码登录」，登录成功后会自动恢复。'
        : '未登录：最近一次握手确认，工作台自己的浏览器会话已未登录小红书，且共用会话（Muse 聊天里的浏览器）也没有更新的登录确认。在 Muse 聊天里让 Muse 打开小红书登录页扫码，或点「打开浏览器扫码登录」，登录成功后会自动恢复。'
  } else if (recordedConfirmed && !stale) {
    verdict = 'logged_in'
    message =
      sharedConfirmedAt != null &&
      (taskConfirmedAt == null || sharedConfirmedAt >= taskConfirmedAt)
        ? session.gate_browser_state === 'logged_in'
          ? '已登录（共用会话）：Muse 聊天里你能看到的浏览器已登录这个账号，工作台自己的浏览器也确认登录着——读取和发布都走这同一个共用登录会话。'
          : '已登录（共用会话）：Muse 聊天里你能看到的浏览器已登录这个账号，工作台认这个登录；工作台自己的任务浏览器还没登录，读取和发布会改走共用会话（在聊天里由 Muse 用已登录的浏览器完成并写回），不会再被任务浏览器的掉线推翻。'
        : session.gate_browser_state === 'logged_in'
          ? '已登录：最近一次握手确认工作台浏览器仍登录着这个账号。'
          : '已登录：工作台已成功读取过这个账号的登录信息，登录态有效；每 60 秒握手会继续确认。'
  } else if (recordedConfirmed && stale) {
    verdict = 'unknown'
    message = checkInFlight
      ? '无法确定：上次确认登录已超过 24 小时，正在重新确认中，结论出来前先按无法确定处理——这不等于掉登录。'
      : '无法确定：上次确认登录已超过 24 小时，之后的确认还没能得出结论。这不等于掉登录——点「打开浏览器扫码登录」或等下一次握手即可重新确认。'
  } else if (primary.login_status === 'failed') {
    verdict = 'logged_out'
    message = '未登录：还没有成功读取过已登录账号信息，目前没有可用的登录态。点「打开浏览器扫码登录」扫码登录后即可恢复。'
  } else if (handshakeTimedOut) {
    verdict = 'unknown'
    message =
      '无法确定：后台登录确认超时——最近一次握手任务超过 10 分钟没有回写结果（任务无回写），未能确认登录态。这不等于掉登录，工作台记录的登录态保持不变；下一次握手会重新确认，想立刻确认也可以打开浏览器扫码登录。'
  } else if (checkInFlight) {
    verdict = 'unknown'
    message =
      session.gate_handshake_status === 'checking'
        ? '无法确定：正在与小红书握手确认登录态（工作台浏览器正在确认当前是否还登录着），结论出来前不下判断。'
        : '无法确定：正在读取已登录账号信息，读取完成后登录态会自动更新，结论出来前不下判断。'
  } else {
    verdict = 'unknown'
    message = '无法确定：还没有确认过这个账号的登录态。点「获取已登录账号信息」读取，或等下一次每 60 秒握手确认。'
  }

  // ---- 派生标志：verdict 的纯函数 ----
  const isLoggedIn = verdict === 'logged_in'
  const state = isLoggedIn
    ? 'valid'
    : verdict === 'logged_out'
      ? 'needs_scan'
      : checkInFlight
        ? 'checking'
        : 'unknown'
  const qrWaiting = infoFetching && session.gate_qr_last_opened_at != null
  const qrWaitDeadlineAt = qrWaiting
    ? toMs(session.gate_qr_last_opened_at) + QR_WAIT_MS
    : null
  const loginSource =
    verdict !== 'logged_in'
      ? 'none'
      : sharedConfirmedAt != null &&
          (taskConfirmedAt == null || sharedConfirmedAt >= taskConfirmedAt)
        ? 'shared_browser'
        : 'task_browser'
  let pendingSharedRequests = 0
  try {
    pendingSharedRequests = store.countPendingSharedRequests()
  } catch {
    pendingSharedRequests = 0
  }

  return {
    verdict,
    state,
    isLoggedIn,
    canFetch: isLoggedIn,
    accountId: primary ? primary.id : null,
    nickname: primary ? primary.nickname : '',
    message,
    recordedStatus: primary ? primary.login_status : 'none',
    lastVerifiedAt: toIso(lastConfirmedAt),
    lastConfirmedAt: toIso(lastConfirmedAt),
    lastHandshakeAt: toIso(lastHandshakeAt),
    handshakeStatus: effectiveHandshakeStatus,
    handshakeMessage: session.gate_handshake_message || '',
    handshakeTimedOut,
    checkInFlight,
    infoFetchTimedOut,
    browserState: session.gate_browser_state,
    sharedState: session.gate_shared_state,
    sharedAt: toIso(toMs(session.gate_shared_at)),
    sharedMessage: session.gate_shared_message || '',
    sharedNickname: session.gate_shared_nickname || '',
    loginSource,
    pendingSharedRequests,
    needsQrLogin: verdict === 'logged_out',
    qrAutoOpenedAt: toIso(toMs(session.gate_qr_auto_opened_at)),
    qrLastOpenedAt: toIso(toMs(session.gate_qr_last_opened_at)),
    qrWaiting,
    qrWaitDeadlineAt: toIso(qrWaitDeadlineAt),
  }
}

// 共用会话通道是否激活：已登录且来源为共用会话且任务浏览器
// conclusively 未登录时，登录依赖型工作改走共用会话请求。
export function sharedChannelActive(gate) {
  return (
    Boolean(gate) &&
    gate.isLoggedIn === true &&
    gate.loginSource === 'shared_browser' &&
    gate.browserState === 'logged_out'
  )
}

export function sharedRouteMessage(label) {
  return `已改走共用登录会话：${label}不在工作台自己的任务浏览器里做（它还没有登录），已经登记到「共用会话请求清单」——回到 Muse 聊天里说一声（比如「按共用会话请求清单处理」），Muse 会用你能看到的那个已登录浏览器完成，并把结果写回这里。`
}
