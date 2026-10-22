export interface SessionUpdateBatcherOptions {
  schedule?: (callback: () => void) => number
  cancel?: (handle: number) => void
}

/**
 * 将短时间内同一会话的高频更新合并为一次提交。
 * 每个 session 独立排队，批处理不会把一个会话的更新写到另一个会话。
 * 使用定时器而不是 requestAnimationFrame：窗口后台时没有可依赖的绘制帧，
 * 但移动端消息仍必须及时写入 renderer 状态。
 */
export function createSessionUpdateBatcher<T>(
  flush: (sessionId: string, updates: readonly T[]) => void,
  options: SessionUpdateBatcherOptions = {},
) {
  const pending = new Map<string, T[]>()
  const scheduled = new Map<string, number>()
  const schedule = options.schedule ?? ((callback: () => void) => {
    return setTimeout(callback, 16) as unknown as number
  })
  const cancel = options.cancel ?? ((handle: number) => {
    clearTimeout(handle)
  })

  const flushSession = (sessionId: string): void => {
    const handle = scheduled.get(sessionId)
    if (handle !== undefined) {
      cancel(handle)
      scheduled.delete(sessionId)
    }
    const updates = pending.get(sessionId)
    if (!updates || updates.length === 0) return
    pending.delete(sessionId)
    flush(sessionId, updates)
  }

  return {
    enqueue(sessionId: string, update: T): void {
      const updates = pending.get(sessionId) ?? []
      updates.push(update)
      pending.set(sessionId, updates)
      if (!scheduled.has(sessionId)) {
        scheduled.set(sessionId, schedule(() => flushSession(sessionId)))
      }
    },
    flush(sessionId: string): void {
      flushSession(sessionId)
    },
    flushAll(): void {
      for (const sessionId of pending.keys()) flushSession(sessionId)
    },
    cancel(sessionId: string): void {
      const handle = scheduled.get(sessionId)
      if (handle !== undefined) cancel(handle)
      scheduled.delete(sessionId)
      pending.delete(sessionId)
    },
  }
}
