import { describe, expect, test } from 'bun:test'
import {
  advanceAgentStreamDrain,
  type AgentStreamDrainState,
  shouldWaitForAgentStreamDrain,
} from './stream-drain'

describe('Agent stream drain lifecycle', () => {
  test('Given a result When iterator is still open Then the runtime keeps waiting', () => {
    let state: AgentStreamDrainState = advanceAgentStreamDrain('open', 'result')
    expect(state).toBe('result_received')
    expect(shouldWaitForAgentStreamDrain(state)).toBe(true)
    state = advanceAgentStreamDrain(state, 'iterator_done')
    expect(state).toBe('closed')
  })

  test('Given iterator completion When a late result arrives Then the stream stays closed', () => {
    const state = advanceAgentStreamDrain('open', 'iterator_done')
    expect(advanceAgentStreamDrain(state, 'result')).toBe('closed')
  })

  test('Given a stop signal When drain is pending Then stop is terminal', () => {
    const state = advanceAgentStreamDrain('open', 'result')
    expect(advanceAgentStreamDrain(state, 'stop')).toBe('stopped')
    expect(advanceAgentStreamDrain('stopped', 'iterator_done')).toBe('stopped')
  })
})
