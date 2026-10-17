import type { AgentStreamDrainSignal, AgentStreamDrainState } from './stream-drain'
import { advanceAgentStreamDrain } from './stream-drain'

export type AgentStreamReadResult<T> =
  | { kind: 'message'; value: T }
  | { kind: 'done' }
  | { kind: 'stopped' }

export interface AgentStreamReader<T> {
  next(...args: []): Promise<IteratorResult<T>>
  return?(value?: unknown): Promise<IteratorResult<T>>
}

export interface ReadAgentStreamNextOptions {
  shouldStop(): boolean
  pollIntervalMs?: number
}

/**
 * 读取一个异步迭代器事件，并在宿主请求停止时主动关闭迭代器。
 *
 * provider 的 next() 可能长期等待工具审批、后台任务或网络响应；这里保留
 * pending next 的 promise，同时用宿主无关的停止谓词打断等待。消息业务解释仍
 * 留在宿主，runtime 只拥有 iterator 的生命周期和 drain 边界。
 */
export async function readAgentStreamNext<T>(
  iterator: AgentStreamReader<T>,
  options: ReadAgentStreamNextOptions,
): Promise<AgentStreamReadResult<T>> {
  if (options.shouldStop()) {
    await closeAgentStreamIterator(iterator)
    return { kind: 'stopped' }
  }

  const pendingNext = Promise.resolve().then(() => iterator.next())
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopResolved = false
  const stopPromise = new Promise<'stopped'>((resolve) => {
    const check = () => {
      if (stopResolved) return
      if (options.shouldStop()) {
        stopResolved = true
        resolve('stopped')
        return
      }
      timer = setTimeout(check, options.pollIntervalMs ?? 200)
    }
    check()
  })

  try {
    const result = await Promise.race([
      pendingNext.then(next => ({ kind: 'next' as const, next })),
      stopPromise.then(kind => ({ kind, next: null })),
    ])
    if (result.kind === 'stopped') {
      pendingNext.catch(() => {})
      await closeAgentStreamIterator(iterator)
      return { kind: 'stopped' }
    }
    if (result.next.done) return { kind: 'done' }
    return { kind: 'message', value: result.next.value }
  } finally {
    if (timer) clearTimeout(timer)
    stopResolved = true
  }
}

export async function closeAgentStreamIterator<T>(iterator: AgentStreamReader<T>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // stop 已经决定了本轮终态；provider 的 close 错误交给下一层统一处理。
  }
}

export interface AgentStreamDrainController {
  state: AgentStreamDrainState
  signal(signal: AgentStreamDrainSignal): AgentStreamDrainState
}

export function createAgentStreamDrainController(): AgentStreamDrainController {
  let state: AgentStreamDrainState = 'open'
  return {
    get state() {
      return state
    },
    signal(signal) {
      state = advanceAgentStreamDrain(state, signal)
      return state
    },
  }
}
