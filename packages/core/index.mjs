// packages/core 的唯一出口：createCore 工厂。
// 业务逻辑全部在 store / gate / generate / bridge / scheduler 里，
// 这里只做依赖注入与绑定，不放业务规则。
//
// createCore({ storage, llm, bridge, clock, logger })
//   storage: 数据库访问接口（表结构与 SQL 语义一律不动），见 store.mjs 头部注释
//   llm:     模型服务（{ stream(...) }），缺失时 generateNote 返回 MODEL_NOT_AVAILABLE
//   bridge:  宿主提供的浏览器桥接传输（{ paired, getStatus, createPairingCode, run }），
//            缺失时 bridge 表现为未配对桩
//   clock:   时间/定时抽象 { now(), nowIso(), setInterval(fn, ms), clearInterval(id) }
//            缺省用全局时间/定时器
//   logger:  日志抽象 { info/warn/error(...args) }，缺省为静默
//   imageGen（可选）: 宿主生图能力 { generate({ prompt, backend }) -> { buffer, mimeType } }；
//            缺失时 generateImage 的 muse/dsh 后端如实返回不可用，绝不假装生成。
//
// 返回：store（表读写）、resolveLoginGate()（已绑定 store+clock）、
//   generateNote(input)（已绑定 store+llm）、generateImage(input)
//   （已绑定 store+imageGen）、bridge（协议实例）、
//   dueHandshake(lastRunAt, now?) / nextRunAt(lastRunAt, now?)、
//   dueHotspotSearch(state, config, now?) / nextHotspotDueAt(...)、
//   HANDSHAKE_INTERVAL_MS / HOTSPOT_TICK_INTERVAL_MS 等常量、
//   nowIso()/nowMs()、以及 SYSTEM_PROMPT、MODEL_NOT_AVAILABLE、
//   GATE_STATES、BRIDGE_NOT_PAIRED 等常量，另原样透出注入的
//   storage、llm、bridgeTransport、clock、logger 供宿主核对。

import { createStore } from './store.mjs'
import { parsePublishedLabel as parsePublishedLabelImpl, parseAbsoluteDateString as parseAbsoluteDateStringImpl, fmtDateKey as fmtDateKeyImpl, toIso as toIsoImpl } from './store.mjs'
import {
  resolveLoginGate as resolveGateImpl,
  GATE_STATES,
  sharedChannelActive as sharedChannelActiveImpl,
  sharedRouteMessage as sharedRouteMessageImpl,
  HANDSHAKE_TIMEOUT_MS,
  INFO_FETCH_TIMEOUT_MS,
  QR_WAIT_MS,
  STALE_MS,
} from './gate.mjs'
import {
  generateNote as generateNoteImpl,
  generateImage as generateImageImpl,
  testImageGenApi as testImageGenApiImpl,
  getImageGenSettingsFromStore,
  SYSTEM_PROMPT,
  MODEL_NOT_AVAILABLE,
  NOTE_STYLES,
  DEFAULT_STYLE,
  STYLE_GUIDANCE,
  IMAGE_GEN_BACKENDS,
} from './generate.mjs'
import { createBridge, BRIDGE_NOT_PAIRED } from './bridge.mjs'
import {
  dueHandshake as dueHandshakeImpl,
  nextRunAt as nextRunAtImpl,
  dueHotspotSearch as dueHotspotSearchImpl,
  nextHotspotDueAt as nextHotspotDueAtImpl,
  HANDSHAKE_INTERVAL_MS,
  HOTSPOT_TICK_INTERVAL_MS,
  HOTSPOT_X_INTERVAL_MS,
  HOTSPOT_KEEP_MS,
  HOTSPOT_MAX_ITEMS_PER_RUN,
} from './scheduler.mjs'

const defaultClock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
}

const nullLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export function createCore(deps = {}) {
  const {
    storage,
    llm = null,
    bridge: bridgeTransport = null,
    clock = defaultClock,
    logger = nullLogger,
    imageGen = null,
  } = deps
  if (!storage) throw new Error('createCore 需要注入 storage')

  const store = createStore({ storage, clock, logger })
  const bridge = createBridge(bridgeTransport)

  function resolveLoginGate() {
    return resolveGateImpl(store, clock)
  }

  function generateNote(input) {
    return generateNoteImpl(input, { store, llm })
  }

  function generateImage(input) {
    return generateImageImpl(input, { store, imageGen })
  }

  function testImageGenApi() {
    return testImageGenApiImpl(store)
  }

  function getImageGenSettings() {
    return getImageGenSettingsFromStore(store)
  }

  function dueHandshake(lastRunAt, now = clock.now()) {
    return dueHandshakeImpl(lastRunAt, now)
  }

  function nextRunAt(lastRunAt, now = clock.now()) {
    return nextRunAtImpl(lastRunAt, now)
  }

  function dueHotspotSearch(state, config, now = clock.now()) {
    return dueHotspotSearchImpl(state, config, now)
  }

  function nextHotspotDueAt(lastAttemptAt, intervalMs, now = clock.now()) {
    return nextHotspotDueAtImpl(lastAttemptAt, intervalMs, now)
  }

  return {
    store,
    resolveLoginGate,
    generateNote,
    generateImage,
    testImageGenApi,
    getImageGenSettings,
    bridge,
    dueHandshake,
    nextRunAt,
    dueHotspotSearch,
    nextHotspotDueAt,
    HANDSHAKE_INTERVAL_MS,
    HOTSPOT_TICK_INTERVAL_MS,
    HOTSPOT_X_INTERVAL_MS,
    HOTSPOT_KEEP_MS,
    HOTSPOT_MAX_ITEMS_PER_RUN,
    nowIso: () => clock.nowIso(),
    nowMs: () => clock.now(),
    clock,
    logger,
    llm,
    imageGen,
    bridgeTransport,
    storage,
    SYSTEM_PROMPT,
    MODEL_NOT_AVAILABLE,
    NOTE_STYLES,
    DEFAULT_STYLE,
    STYLE_GUIDANCE,
    IMAGE_GEN_BACKENDS,
    GATE_STATES,
    BRIDGE_NOT_PAIRED,
    sharedChannelActive: sharedChannelActiveImpl,
    sharedRouteMessage: sharedRouteMessageImpl,
    parsePublishedLabel: parsePublishedLabelImpl,
    parseAbsoluteDateString: parseAbsoluteDateStringImpl,
    fmtDateKey: fmtDateKeyImpl,
    toIso: toIsoImpl,
  }
}

export { createStore } from './store.mjs'
export {
  resolveLoginGate as resolveLoginGateWith,
  GATE_STATES,
  sharedChannelActive,
  sharedRouteMessage,
  HANDSHAKE_TIMEOUT_MS,
  INFO_FETCH_TIMEOUT_MS,
  QR_WAIT_MS,
  STALE_MS,
} from './gate.mjs'
export {
  generateNote as generateNoteWith,
  generateImage as generateImageWith,
  testImageGenApi as testImageGenApiWith,
  SYSTEM_PROMPT,
  MODEL_NOT_AVAILABLE,
  NOTE_STYLES,
  DEFAULT_STYLE,
  STYLE_GUIDANCE,
  IMAGE_GEN_BACKENDS,
} from './generate.mjs'
export { createBridge, BRIDGE_NOT_PAIRED } from './bridge.mjs'
export {
  dueHandshake as dueHandshakePure,
  nextRunAt as nextRunAtPure,
  dueHotspotSearch as dueHotspotSearchPure,
  nextHotspotDueAt as nextHotspotDueAtPure,
  HANDSHAKE_INTERVAL_MS,
  HOTSPOT_TICK_INTERVAL_MS,
  HOTSPOT_X_INTERVAL_MS,
  HOTSPOT_KEEP_MS,
  HOTSPOT_MAX_ITEMS_PER_RUN,
} from './scheduler.mjs'
export {
  parsePublishedLabel,
  parseAbsoluteDateString,
  fmtDateKey,
  toIso,
  COLUMNS,
  TIME_COLUMNS,
} from './store.mjs'
