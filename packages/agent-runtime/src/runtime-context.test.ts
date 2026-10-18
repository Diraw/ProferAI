import { describe, expect, test } from 'bun:test'
import { AgentRuntimeContextStore } from './runtime-context'

describe('AgentRuntimeContextStore', () => {
  test('Given active sessions When snapshots are listed Then filtering preserves context metadata', () => {
    const store = new AgentRuntimeContextStore()
    store.setContextWindow('session-a', 1_000_000, 100)
    store.setContextWindow('session-b', 200_000, 200)
    expect(store.list(['session-a'])).toEqual([
      { sessionId: 'session-a', contextWindow: 1_000_000, updatedAt: 100 },
    ])
  })

  test('Given invalid context When recorded Then it is ignored', () => {
    const store = new AgentRuntimeContextStore()
    store.setContextWindow('', 200_000)
    store.setContextWindow('session', 0)
    store.setContextWindow('session', Number.NaN)
    expect(store.list()).toEqual([])
  })

  test('Given a completed session When cleared Then it is absent from future snapshots', () => {
    const store = new AgentRuntimeContextStore()
    store.setContextWindow('session', 200_000)
    store.clear('session')
    expect(store.list()).toEqual([])
  })
})
