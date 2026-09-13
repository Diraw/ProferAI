/** 插件调用的并发、限流与取消独立于页面代码，撤权后立即终止。 */
export class PluginRequests {
  private readonly active = new Map<string, Map<string, { controller: AbortController; ownerId?: number }>>()
  private readonly recent = new Map<string, number[]>()
  async run<T>(pluginId: string, requestId: string, operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 60_000, ownerId?: number): Promise<T> {
    const calls = this.active.get(pluginId) ?? new Map<string, { controller: AbortController; ownerId?: number }>()
    if (calls.has(requestId)) throw new Error('requestId 已在使用')
    if (calls.size >= 4) throw new Error('插件最多同时进行 4 项调用')
    const recent = (this.recent.get(pluginId) ?? []).filter((time) => Date.now() - time < 60_000)
    if (recent.length >= 30) throw new Error('插件调用过于频繁，请稍后重试')
    recent.push(Date.now()); this.recent.set(pluginId, recent)
    const controller = new AbortController()
    calls.set(requestId, { controller, ownerId }); this.active.set(pluginId, calls)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let onAbort: () => void = () => undefined
    try {
      return await Promise.race([operation(controller.signal), new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('插件调用已取消或超时'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) onAbort()
      })])
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort)
      calls.delete(requestId)
      if (calls.size === 0) this.active.delete(pluginId)
    }
  }
  cancel(pluginId: string, requestId: string): void { this.active.get(pluginId)?.get(requestId)?.controller.abort() }
  cancelOwner(ownerId: number): void {
    for (const calls of this.active.values()) for (const call of calls.values()) if (call.ownerId === ownerId) call.controller.abort()
  }
  cancelPlugin(pluginId: string): void { for (const call of this.active.get(pluginId)?.values() ?? []) call.controller.abort() }
}
export const pluginRequests = new PluginRequests()
