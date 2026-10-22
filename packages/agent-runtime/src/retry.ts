export type RetryWaitResult = 'completed' | 'stopped'

export interface RetryWaitOptions {
  signal?: AbortSignal
  shouldStop?: () => boolean
  pollIntervalMs?: number
}

/** 等待退避时间，同时允许宿主在等待期间取消本轮。 */
export function waitForRetryDelay(delayMs: number, options: RetryWaitOptions = {}): Promise<RetryWaitResult> {
  if (delayMs <= 0) return Promise.resolve(options.signal?.aborted || options.shouldStop?.() ? 'stopped' : 'completed')
  if (options.signal?.aborted || options.shouldStop?.()) return Promise.resolve('stopped')

  return new Promise<RetryWaitResult>(resolve => {
    let settled = false
    let delayTimer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (delayTimer) clearTimeout(delayTimer)
      if (pollTimer) clearTimeout(pollTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (result: RetryWaitResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onAbort = () => finish('stopped')
    const poll = () => {
      if (settled) return
      if (options.signal?.aborted || options.shouldStop?.()) {
        finish('stopped')
        return
      }
      pollTimer = setTimeout(poll, options.pollIntervalMs ?? 200)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    delayTimer = setTimeout(() => finish('completed'), delayMs)
    poll()
  })
}

export const DEFAULT_MAX_RETRIES = 25
export const DEFAULT_MAX_RETRY_WAIT_MS = 5 * 60_000
export const DEFAULT_RETRY_MAX_DELAY_MS = 15_000

export interface RetryPolicy {
  maxRetries?: number
  maxWaitMs?: number
  maxDelayMs?: number
  random?: () => number
}

export interface RetryError {
  statusCode?: number
  message?: string
}

export function isRetryableError(error: RetryError | null | undefined, rawMessage = ''): boolean {
  const text = `${error?.message ?? ''}\n${rawMessage}`
  if (error?.statusCode === 429 || (error?.statusCode !== undefined && error.statusCode >= 500)) return true
  return /\b(?:502|503|529)\b|overloaded|too many requests|rate.?limit|temporarily unavailable|service unavailable|request could not be completed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(text)
}

export function isRetryBudgetExhausted(elapsedMs: number, maxWaitMs = DEFAULT_MAX_RETRY_WAIT_MS): boolean {
  return elapsedMs >= maxWaitMs
}

/** 计算带 ±20% jitter 的指数退避；预算和延迟都是纯函数输入。 */
export function getRetryDelayMs(
  attempt: number,
  elapsedMs: number,
  policy: RetryPolicy = {},
): number {
  const maxWaitMs = policy.maxWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
  const remainingMs = maxWaitMs - elapsedMs
  if (remainingMs <= 0) return 0

  const random = policy.random ?? Math.random
  const base = Math.min(1000 * Math.pow(2, Math.max(0, attempt - 1)), maxDelayMs)
  const jittered = base * (0.8 + random() * 0.4)
  return Math.min(remainingMs, Math.max(0, Math.round(jittered)))
}

export function canRetry(attempt: number, elapsedMs: number, policy: RetryPolicy = {}): boolean {
  const maxRetries = policy.maxRetries ?? DEFAULT_MAX_RETRIES
  const maxWaitMs = policy.maxWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS
  return attempt <= maxRetries && !isRetryBudgetExhausted(elapsedMs, maxWaitMs)
}
