/**
 * remote-agent-replay-registry 单测（GAP-3）
 *
 * 覆盖要求（任务书 Task 2.4）：绑定、刷新回放、重连幂等、无客户端时的行为。
 * 全部为纯内存单元测试：不启动 WS、不连接 Pocket、不读用户目录。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload } from '@profer/shared'
import { RemoteAgentReplayRegistry, type RemoteReplayRecord } from './remote-agent-replay-registry'

let nextEventId = 1
function sdkMessage(text: string): AgentStreamPayload {
  return { kind: 'sdk_message', message: { type: 'assistant', text } as never }
}
function runCompleted(sessionId: string): AgentStreamPayload {
  return { kind: 'profer_event', event: { type: 'run_completed', sessionId } }
}
function runIdle(sessionId: string): AgentStreamPayload {
  return { kind: 'profer_event', event: { type: 'run_idle', sessionId } }
}
function record(sessionId: string, payload: AgentStreamPayload, eventId = nextEventId++, createdAt = 1_000): RemoteReplayRecord {
  return { eventId, sessionId, payload, createdAt }
}

function makeRegistry(now = () => 1_000) {
  nextEventId = 1
  return new RemoteAgentReplayRegistry({ now })
}

describe('客户端绑定', () => {
  test('已绑定客户端只看到自己关注的会话；多客户端互不干扰', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-b', sdkMessage('b1')))

    registry.bindClient('client-1', 's-a')
    registry.bindClient('client-2', 's-b')
    registry.bindClient('client-2', 's-b') // 重复绑定幂等

    expect(registry.sessionsFor('client-1').map((s) => s.sessionId)).toEqual(['s-a'])
    expect(registry.sessionsFor('client-2').map((s) => s.sessionId)).toEqual(['s-b'])
    expect(registry.replayFor('client-1').records.map((r) => r.sessionId)).toEqual(['s-a'])
    expect(registry.replayFor('client-2').records.map((r) => r.sessionId)).toEqual(['s-b'])
  })

  test('一个客户端可绑定多个会话；解除绑定后回落到「全部活跃会话」', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-b', sdkMessage('b1')))

    registry.bindClient('client-1', 's-a')
    registry.bindClient('client-1', 's-b')
    expect(registry.sessionsFor('client-1').map((s) => s.sessionId)).toEqual(['s-a', 's-b'])

    registry.unbindClient('client-1', 's-a')
    expect(registry.sessionsFor('client-1').map((s) => s.sessionId)).toEqual(['s-b'])
    registry.unbindClient('client-1')
    expect(registry.hasClient('client-1')).toBe(false)
    expect(registry.sessionsFor('client-1').map((s) => s.sessionId)).toEqual(['s-a', 's-b'])
  })
})

describe('刷新回放', () => {
  test('刷新后的新客户端（无绑定、无游标）能拿到正在飞的一轮完整事件序列', () => {
    const registry = makeRegistry()
    const first = registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-a', sdkMessage('a2')))
    expect(first).toBe(true)

    // 桌面刷新语义：未绑定客户端按「全部活跃会话」回放，而不是空回放。
    const batch = registry.replayFor('fresh-pocket')
    expect(batch.requiresSnapshot).toBe(false)
    expect(batch.sessions).toEqual([
      { sessionId: 's-a', active: true, hasTerminalEvent: false, latestEventId: 2, eventCount: 2 },
    ])
    expect(batch.records.map((r) => r.eventId)).toEqual([1, 2])
    expect(batch.oldestEventId).toBe(1)
    expect(batch.latestEventId).toBe(2)
  })

  test('刚结束的一轮在 TTL 内仍可回放，且标记为非活跃 + 已有终态', () => {
    let now = 1_000
    const registry = new RemoteAgentReplayRegistry({ now: () => now, completedTtlMs: 60_000 })
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-a', runCompleted('s-a')))

    const batch = registry.replayFor('fresh-pocket')
    expect(batch.sessions[0]).toMatchObject({ sessionId: 's-a', active: false, hasTerminalEvent: true })
    expect(batch.records.map((r) => r.payload.kind)).toEqual(['sdk_message', 'profer_event'])

    now += 60_001
    expect(registry.replayFor('fresh-pocket').records).toEqual([])
    expect(registry.size).toBe(0)
  })

  test('只有 run_idle（没等到终态）时也保留一个 TTL 窗口，而不是立刻丢弃', () => {
    let now = 1_000
    const registry = new RemoteAgentReplayRegistry({ now: () => now, completedTtlMs: 60_000 })
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-a', runIdle('s-a')))

    const batch = registry.replayFor('fresh-pocket')
    expect(batch.sessions[0]).toMatchObject({ active: false, hasTerminalEvent: false })
    expect(batch.records).toHaveLength(2)
  })

  test('多轮会话：终态之后又出现非终态事件即视为新一轮，重新变回活跃', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('r1')))
    registry.observe(record('s-a', runCompleted('s-a')))
    expect(registry.sessionsFor('pocket')[0]!.active).toBe(false)

    registry.observe(record('s-a', sdkMessage('r2')))
    expect(registry.sessionsFor('pocket')[0]).toMatchObject({ active: true, hasTerminalEvent: false })
  })

  test('会话无关的全局投影事件不登记（与桌面 backlog 中间件同一排除口径）', () => {
    const registry = makeRegistry()
    expect(registry.observe(record('s-a', { kind: 'session_projection', session: { id: 's-a' } } as never))).toBe(false)
    expect(registry.observe(record('s-a', { kind: 'catalog_invalidation', scope: 'agents' } as never))).toBe(false)
    expect(registry.size).toBe(0)
  })
})

describe('重连 / 重放幂等', () => {
  test('重复回放同一游标不产生重复消息（第二次为空）', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-a', sdkMessage('a2')))

    const first = registry.replayFor('pocket', { sinceEventId: null })
    expect(first.records.map((r) => r.eventId)).toEqual([1, 2])
    const second = registry.replayFor('pocket', { sinceEventId: first.latestEventId })
    expect(second.records).toEqual([])
  })

  test('回放后新增事件：只补增量，不重发历史', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-a', sdkMessage('a2')))
    const first = registry.replayFor('pocket', { sinceEventId: null })

    registry.observe(record('s-a', sdkMessage('a3')))
    const second = registry.replayFor('pocket', { sinceEventId: first.latestEventId })
    expect(second.records.map((r) => r.eventId)).toEqual([3])
  })

  test('重复登记同一 eventId 被忽略（弱网重放不得重复入账）', () => {
    const registry = makeRegistry()
    const dup = record('s-a', sdkMessage('a1'), 7)
    expect(registry.observe(dup)).toBe(true)
    expect(registry.observe({ ...dup })).toBe(false)
    expect(registry.replayFor('pocket').records).toHaveLength(1)
  })

  test('迟到 / 重复终态被丢弃：不会产生重复终态帧', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-a', runCompleted('s-a')))
    // 同一轮的第二条终态（例如 run_completed 与 run_complete 都到达）
    expect(registry.observe(record('s-a', { kind: 'run_complete', completion: {} } as never))).toBe(false)

    const batch = registry.replayFor('pocket')
    const terminals = batch.records.filter((r) => r.payload.kind !== 'sdk_message')
    expect(terminals).toHaveLength(1)
    expect(batch.sessions[0]).toMatchObject({ active: false, hasTerminalEvent: true })
  })
})

describe('无客户端 / 登记不完整', () => {
  test('没有任何客户端时登记照常进行（observe 不依赖客户端）', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    expect(registry.size).toBe(1)
    expect(registry.sessionsFor('never-connected')[0]!.sessionId).toBe('s-a')
  })

  test('登记为空时回放为空且不需要快照（等价于「没有在飞的一轮」）', () => {
    const registry = makeRegistry()
    const batch = registry.replayFor('pocket')
    expect(batch).toEqual({
      sessions: [],
      records: [],
      requiresSnapshot: false,
      oldestEventId: null,
      latestEventId: null,
    })
  })

  test('显式请求的会话不在登记里：空结果 + 不需要快照（客户端按常规消息接口取历史）', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    const batch = registry.replayFor('pocket', { sessionIds: ['s-missing'] })
    expect(batch.sessions).toEqual([])
    expect(batch.records).toEqual([])
    expect(batch.requiresSnapshot).toBe(false)
  })

  test('单会话事件超出容量上限 ⇒ 登记不完整，必须取快照（不发送半段事件）', () => {
    const registry = new RemoteAgentReplayRegistry({ maxRecordsPerSession: 2, now: () => 1_000 })
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.observe(record('s-a', sdkMessage('a2')))
    registry.observe(record('s-a', sdkMessage('a3')))

    const batch = registry.replayFor('pocket')
    expect(batch.requiresSnapshot).toBe(true)
    expect(batch.records).toEqual([])
    expect(batch.sessions[0]!.eventCount).toBe(2)
  })

  test('会话数超上限时优先淘汰已结束且最旧的会话，仍在进行的保留', () => {
    const registry = new RemoteAgentReplayRegistry({ maxSessions: 2, now: () => 1_000 })
    registry.observe(record('s-done', sdkMessage('d1'), 1))
    registry.observe(record('s-done', runCompleted('s-done'), 2))
    registry.observe(record('s-live', sdkMessage('l1'), 3))

    expect(registry.sessionsFor('pocket').map((s) => s.sessionId)).toEqual(['s-done', 's-live'])
    registry.observe(record('s-new', sdkMessage('n1'), 4))
    // s-done 是唯一已结束的会话 → 被淘汰；两个活跃会话保留
    expect(registry.sessionsFor('pocket').map((s) => s.sessionId)).toEqual(['s-live', 's-new'])
  })

  test('clearSession 释放指定会话登记', () => {
    const registry = makeRegistry()
    registry.observe(record('s-a', sdkMessage('a1')))
    registry.clearSession('s-a')
    expect(registry.size).toBe(0)
    expect(registry.replayFor('pocket').records).toEqual([])
  })
})
