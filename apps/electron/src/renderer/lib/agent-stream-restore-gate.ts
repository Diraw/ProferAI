/**
 * 刷新恢复窗口的终态闸门。
 *
 * renderer 大刷新后会调用 `restoreActiveAgentStreams()`：main 侧同步回放本轮 backlog，
 * 并按当前登记窗口补发终态 IPC；而 renderer 的 running 占位要等这次 IPC **返回之后**
 * 才在 `.then` 里写入。若本轮 run 恰好在这个窗口内结束，终态会先于占位到达，
 * 专用 handler 的竞态保护（`isCurrentAgentStreamCompletion` 要求 running/backgroundWaiting）
 * 会把它当作迟到终态丢弃，收尾副作用（通知、未查看标记、消息重载、finalize）全部丢失，
 * 极端情况下刷新后残留 spinner。
 *
 * 闸门把这段时间内到达的终态暂存起来，等占位写入后（`settle()`）按原顺序派发。
 * 已经存在流式状态的会话不暂存：那说明 backlog 或其他事件已经建立了状态，
 * 直接派发即可通过竞态保护，也能避免延迟用户可见的收尾动作。
 */
export class AgentStreamRestoreGate {
  private settled = false
  private readonly deferred: Array<() => void> = []

  constructor(private readonly hasStreamState: (sessionId: string) => boolean) {}

  /**
   * 判断终态是否需要延后派发。
   *
   * @returns true 表示已暂存，调用方必须立刻返回、不要再执行终态处理。
   */
  defer(sessionId: string, dispatch: () => void): boolean {
    if (this.settled) return false
    if (this.hasStreamState(sessionId)) return false
    this.deferred.push(dispatch)
    return true
  }

  /** 占位写入完成后调用：放行暂存的终态，之后到达的终态一律立即派发。 */
  settle(): void {
    this.settled = true
    const pending = this.deferred.splice(0)
    for (const dispatch of pending) dispatch()
  }

  /** 仅供测试与诊断：当前暂存数量。 */
  get pendingCount(): number {
    return this.deferred.length
  }
}
