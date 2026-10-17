import { describe, expect, test } from 'bun:test'
import {
  canRetry,
  getRetryDelayMs,
  isRetryBudgetExhausted,
  isRetryableError,
  waitForRetryDelay,
} from './retry'

describe('Agent retry policy', () => {
  test('Given transient upstream errors Then retry is allowed', () => {
    expect(isRetryableError({ statusCode: 429, message: 'rate limit' })).toBe(true)
    expect(isRetryableError({ statusCode: 503, message: 'busy' })).toBe(true)
    expect(isRetryableError(null, 'ECONNRESET')).toBe(true)
  })

  test('Given authentication or malformed request errors Then retry is rejected', () => {
    expect(isRetryableError({ statusCode: 401, message: 'invalid api key' })).toBe(false)
    expect(isRetryableError({ statusCode: 400, message: 'bad request' })).toBe(false)
  })

  test('Given an exhausted budget Then zero delay does not imply another retry', () => {
    expect(getRetryDelayMs(1, 1000, { maxWaitMs: 1000, random: () => 0.5 })).toBe(0)
    expect(isRetryBudgetExhausted(1000, 1000)).toBe(true)
    expect(canRetry(1, 1000, { maxWaitMs: 1000 })).toBe(false)
  })

  test('Given a pending retry delay When the host stops Then the wait resolves stopped and clears its timers', async () => {
    let stopped = false
    const wait = waitForRetryDelay(50, { shouldStop: () => stopped, pollIntervalMs: 1 })
    stopped = true
    await expect(wait).resolves.toBe('stopped')
  })

  test('Given an aborted retry delay When waiting Then it resolves stopped without waiting the full delay', async () => {
    const controller = new AbortController()
    const wait = waitForRetryDelay(10_000, { signal: controller.signal })
    controller.abort('user_stop')
    await expect(wait).resolves.toBe('stopped')
  })

  test('Given a zero retry delay When not stopped Then it resolves immediately', async () => {
    await expect(waitForRetryDelay(0)).resolves.toBe('completed')
  })

  test('Given a retry attempt Then delay follows exponential backoff and remaining budget', () => {
    expect(getRetryDelayMs(1, 0, { random: () => 0 })).toBe(800)
    expect(getRetryDelayMs(2, 0, { random: () => 1 })).toBe(2400)
    expect(getRetryDelayMs(1, 0, { maxWaitMs: 500, random: () => 1 })).toBe(500)
  })
})

