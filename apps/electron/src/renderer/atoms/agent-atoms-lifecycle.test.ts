import { describe, expect, test } from 'bun:test'
import { applyAgentEvent, deleteSessionMapEntry, type AgentStreamState } from './agent-atoms'

function runningState(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    content: '',
    toolActivities: [],
    ...overrides,
  }
}

describe('session-keyed heavy cache release', () => {
  test('Given the session exists When deleted Then returns a new Map without that entry', () => {
    const a = { messages: 10 }
    const b = { messages: 20 }
    const prev = new Map([['a', a], ['b', b]])

    const next = deleteSessionMapEntry(prev, 'a')

    expect(next).not.toBe(prev)
    expect(next.has('a')).toBe(false)
    expect(next.get('b')).toBe(b)
    expect(prev.has('a')).toBe(true) // 不修改入参
  })

  test('Given the session is absent When deleted Then keeps the same Map reference', () => {
    const prev = new Map([['a', 1]])
    expect(deleteSessionMapEntry(prev, 'missing')).toBe(prev)
  })
})

describe('Agent renderer lifecycle ownership', () => {
  test('Given an SDK error event When main ownership is not released Then keeps the renderer run active', () => {
    const current = runningState({ isCompacting: true, compactInFlight: true })

    expect(applyAgentEvent(current, {
      type: 'error',
      message: 'Upstream response stream was interrupted',
    })).toBe(current)
  })

  test('Given a typed error event When main ownership is not released Then only clears retry UI', () => {
    const next = applyAgentEvent(runningState({
      retrying: {
        currentAttempt: 2,
        maxAttempts: 8,
        history: [],
        failed: false,
      },
    }), {
      type: 'typed_error',
      error: {
        code: 'network_error',
        title: '网络异常',
        message: 'Upstream response stream was interrupted',
        actions: [],
        canRetry: true,
      },
    })

    expect(next.running).toBe(true)
    expect(next.retrying).toBeUndefined()
  })
})
