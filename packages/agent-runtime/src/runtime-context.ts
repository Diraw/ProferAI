export interface AgentRuntimeContextSnapshot {
  sessionId: string
  contextWindow: number
  updatedAt: number
}

/** 仅保存活动 run 的上下文窗口快照，不承担桌面宿主或持久化职责。 */
export class AgentRuntimeContextStore {
  private readonly snapshots = new Map<string, AgentRuntimeContextSnapshot>()

  setContextWindow(sessionId: string, contextWindow: number, updatedAt = Date.now()): void {
    if (!sessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) return
    this.snapshots.set(sessionId, { sessionId, contextWindow, updatedAt })
  }

  clear(sessionId: string): void {
    this.snapshots.delete(sessionId)
  }

  list(sessionIds?: readonly string[]): AgentRuntimeContextSnapshot[] {
    if (!sessionIds) return [...this.snapshots.values()]
    const allowed = new Set(sessionIds)
    return [...this.snapshots.values()].filter((snapshot) => allowed.has(snapshot.sessionId))
  }
}
