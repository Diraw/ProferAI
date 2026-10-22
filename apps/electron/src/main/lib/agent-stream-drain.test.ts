import { describe, expect, test } from 'bun:test'
import { advanceAgentStreamDrain, type AgentStreamDrainState, shouldWaitForAgentStreamDrain } from './agent-stream-drain'

describe('Agent stream drain lifecycle', () => {
  test('result 后必须等 iterator done 才关闭', () => {
    let state: AgentStreamDrainState = 'open'
    state = advanceAgentStreamDrain(state, 'result')
    expect(state).toBe('result_received')
    expect(shouldWaitForAgentStreamDrain(state)).toBe(true)
    state = advanceAgentStreamDrain(state, 'iterator_done')
    expect(state).toBe('closed')
    expect(shouldWaitForAgentStreamDrain(state)).toBe(false)
  })

  test('iterator done 早于 result 时保持关闭且迟到 result 不复活', () => {
    let state: AgentStreamDrainState = advanceAgentStreamDrain('open', 'iterator_done')
    expect(advanceAgentStreamDrain(state, 'result')).toBe('closed')
  })

  test('用户停止可以打断等待中的 drain，但重复信号不能复活流', () => {
    let state: AgentStreamDrainState = advanceAgentStreamDrain('open', 'result')
    state = advanceAgentStreamDrain(state, 'stop')
    expect(state).toBe('stopped')
    expect(advanceAgentStreamDrain(state, 'iterator_done')).toBe('stopped')
  })
})
