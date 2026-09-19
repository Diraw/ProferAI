/**
 * Agent 会话事件扇出（纯逻辑）
 *
 * 背景：桌面端在应用内 UI 完成作答（权限询问 / Agent 追问 / 计划审批）时，既要让
 * 事件进入 agentEventBus（remote-service 据此广播给 Pocket，并写入 WS 事件重放日志），
 * 又要保证渲染层一定收到「已解决」事件（否则横幅不消失）。
 *
 * 但 agent-service 的 EventBus 中间件本身已经会把事件转发给该 session 已绑定的
 * webContents，于是「emit 事件总线」+「handler 里再 event.sender.send 一次」会让
 * 同一窗口的渲染层收到两份同事件。
 *
 * 本模块把「是否还需要兜底直发」的判定抽成不依赖 electron 运行时的纯函数：
 * - 已绑定且就是发起方 → 中间件已转发，不再直发（消除重复投递）
 * - 未绑定 / 绑定已销毁 / 绑定不是发起方 → 中间件不会或不该转发，直发兜底
 * - sessionId 为空（过期 request）→ 整件事都不做
 *
 * 错误处理边界：本模块只做判定与调用转发，自身不抛异常（全程 null/undefined 守卫）；
 * 真正的 I/O 失败（WebContents.send 抛错）由调用方在 sendToSender 适配层里
 * try/catch + console.error 兜住，与 EventBus 中间件现有风格一致。
 */

/** 只依赖 send 目标的最小接口，便于单测注入 fake */
export interface StreamSenderLike {
  isDestroyed(): boolean
}

/** 扇出所需的三个适配口，由调用方绑定到真实的事件总线与会话 webContents 映射 */
export interface SessionEventFanout {
  /** 写入事件总线：广播给 Pocket + 写重放日志 + 中间件转发已绑定 renderer */
  emitToBus: (sessionId: string, payload: unknown) => void
  /** 读取该会话当前绑定的 webContents（无绑定时返回 undefined/null） */
  getBoundSender: (sessionId: string) => StreamSenderLike | undefined | null
  /** 兜底直发（调用方负责 try/catch，失败只记录日志） */
  sendToSender: (sender: StreamSenderLike, sessionId: string, payload: unknown) => void
}

export interface FanoutResult {
  /** 是否已写入事件总线（sessionId 为空时为 false） */
  deliveredToBus: boolean
  /** 是否额外做了兜底直发 */
  fallbackSent: boolean
}

/**
 * 扇出一个会话事件。
 *
 * @param fanout 事件总线 / 绑定查询 / 兜底直发的适配口
 * @param sessionId 目标会话；为空表示 request 已过期，不下发任何 resolved 事件
 * @param payload 事件载荷（原样透传，不做形状加工）
 * @param fallbackSender 发起方 webContents（通常是 IPC handler 的 event.sender）
 */
export function fanoutSessionEvent(
  fanout: SessionEventFanout,
  sessionId: string | undefined | null,
  payload: unknown,
  fallbackSender?: StreamSenderLike | null,
): FanoutResult {
  // 过期 request 的守卫：拿不到 sessionId 就没有广播与重放的归属，直接静默返回，
  // 避免把 resolved 事件投给错误的会话。
  if (!sessionId) {
    return { deliveredToBus: false, fallbackSent: false }
  }

  // 事件总线是唯一权威出口：remote-service 广播 Pocket、重放日志、已绑定 renderer 的转发都在这里发生。
  fanout.emitToBus(sessionId, payload)

  const bound = fanout.getBoundSender(sessionId)
  // 仅当中间件无法覆盖当前发起方时才直发：
  // - 无绑定（如窗口关闭后重开：旧 wc 已被清理，且该 session 不在重连恢复的
  //   activeStreamEventBacklogs / completedStreamEventBacklogs 快照里）
  // - 绑定已销毁（中间件会跳过，发送无意义）
  // - 绑定不是发起方（中间件会发给另一个窗口，发起方仍需自己的那份）
  const needsFallback = !bound || bound.isDestroyed() || bound !== fallbackSender

  if (needsFallback && fallbackSender && !fallbackSender.isDestroyed()) {
    fanout.sendToSender(fallbackSender, sessionId, payload)
    return { deliveredToBus: true, fallbackSent: true }
  }

  return { deliveredToBus: true, fallbackSent: false }
}
