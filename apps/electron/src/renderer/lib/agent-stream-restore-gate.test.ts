import { describe, expect, test } from 'bun:test'
import { AgentStreamRestoreGate } from '@/lib/agent-stream-restore-gate'

/** 模拟 renderer 的 agentStreamingStatesAtom：只有 key 存在才算「本会话已有流式状态」。 */
function streamStates(...sessionIds: string[]): (sessionId: string) => boolean {
  const known = new Set(sessionIds)
  return (sessionId) => known.has(sessionId)
}

describe('AgentStreamRestoreGate', () => {
  test('Given 刷新恢复尚未结束且本会话没有流式状态 When 终态到达 Then 暂存而不是直接派发', () => {
    const gate = new AgentStreamRestoreGate(streamStates())
    const dispatched: string[] = []

    expect(gate.defer('s1', () => dispatched.push('complete'))).toBe(true)
    expect(dispatched).toEqual([])
    expect(gate.pendingCount).toBe(1)
  })

  test('Given 恢复期间已回放出流式状态 When 终态到达 Then 立即派发（竞态保护能通过，不拖延可见收尾）', () => {
    const gate = new AgentStreamRestoreGate(streamStates('s1'))
    const dispatched: string[] = []

    // defer 返回 false 表示「请调用方立刻自行派发」，这里模拟专用 handler 的分支
    const deferred = gate.defer('s1', () => dispatched.push('complete'))
    if (!deferred) dispatched.push('complete')

    expect(deferred).toBe(false)
    expect(dispatched).toEqual(['complete'])
    expect(gate.pendingCount).toBe(0)
  })

  test('Given 暂存了终态 When 占位写入后 settle Then 按原顺序派发且之后不再暂存', () => {
    const gate = new AgentStreamRestoreGate(streamStates())
    const dispatched: string[] = []
    const deliver = (sessionId: string, label: string): void => {
      if (!gate.defer(sessionId, () => dispatched.push(label))) dispatched.push(label)
    }

    deliver('s1', 'complete:s1')
    deliver('s2', 'error:s2')
    expect(dispatched).toEqual([])

    gate.settle()
    expect(dispatched).toEqual(['complete:s1', 'error:s2'])
    expect(gate.pendingCount).toBe(0)

    // settle 之后即使会话仍无状态也立即派发，不再堆积
    deliver('s1', 'complete:s1:again')
    expect(dispatched).toEqual(['complete:s1', 'error:s2', 'complete:s1:again'])
    expect(gate.pendingCount).toBe(0)
  })

  test('Given settle 被重复调用 When 派发 Then 不会重复执行已放行的终态', () => {
    const gate = new AgentStreamRestoreGate(streamStates())
    const dispatched: string[] = []

    gate.defer('s1', () => dispatched.push('complete'))
    gate.settle()
    gate.settle()
    expect(dispatched).toEqual(['complete'])
  })

  test('Given 用户在新 run 开始后触发 settle When 派发旧终态 Then 仍由调用方的竞态保护决定是否生效', () => {
    // 闸门只负责时序，不判断 run 归属：新 run 的状态在 settle 前已写入，
    // defer 会返回 false；如果它是在 settle 后到达，则立即派发并由 startedAt 竞态保护裁决。
    const gate = new AgentStreamRestoreGate(streamStates('s1'))
    const dispatched: string[] = []

    const deferred = gate.defer('s1', () => dispatched.push('stale-complete'))
    if (!deferred) dispatched.push('stale-complete')

    gate.settle()
    expect(dispatched).toEqual(['stale-complete'])
    expect(gate.pendingCount).toBe(0)
  })
})
