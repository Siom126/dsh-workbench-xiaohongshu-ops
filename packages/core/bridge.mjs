// 浏览器桥协议层（v1：未配对实现）。
//
// 只保留协议逻辑：状态查询、配对码、任务执行的请求/响应形状。
// 真正的传输由宿主注入（createBridge 的 transport 参数）：
//   transport = { paired: true, getStatus(), createPairingCode(), run(task) }
// 未注入传输（v1）时所有调用都明确返回“未配对”，绝不假装读到了数据。
// core 绝不直接碰任何宿主能力。

export const BRIDGE_NOT_PAIRED = 'BRIDGE_NOT_PAIRED'

/**
 * 创建桥实例。transport 为宿主提供的浏览器桥接传输，未提供时为未配对桩。
 * 只有 transport.paired === true 时才委托给传输，否则一律返回未配对说明。
 */
export function createBridge(transport = null) {
  const hasTransport = Boolean(transport) && transport.paired === true

  /** 桥当前状态：v1 恒为未配对。 */
  function getBridgeStatus() {
    if (hasTransport && typeof transport.getStatus === 'function') {
      return transport.getStatus()
    }
    return {
      paired: false,
      message: '未配对浏览器扩展：当前没有可用的浏览器扩展，无法读取小红书页面。',
    }
  }

  /**
   * 生成一次性配对码（2 分钟有效，仅作占位）。
   * 扩展未接入时不生成可用配对码，只返回未实现说明。
   */
  function pairingCode() {
    if (hasTransport && typeof transport.createPairingCode === 'function') {
      return transport.createPairingCode()
    }
    return {
      ok: false,
      code: BRIDGE_NOT_PAIRED,
      message: '浏览器扩展未接入，配对功能暂未实现，无法生成有效配对码。',
      validSeconds: 120,
    }
  }

  /**
   * 执行一项浏览器读取任务。
   * 未配对时返回明确失败，绝不返回伪造的页面数据。
   */
  async function run(task) {
    if (hasTransport && typeof transport.run === 'function') {
      return transport.run(task)
    }
    return {
      ok: false,
      code: BRIDGE_NOT_PAIRED,
      message: '需要浏览器扩展才能读取小红书页面，当前未配对，未读取任何数据。',
      task: task?.kind ?? task?.type ?? null,
    }
  }

  return {
    paired: hasTransport,
    getBridgeStatus,
    pairingCode,
    run,
  }
}
