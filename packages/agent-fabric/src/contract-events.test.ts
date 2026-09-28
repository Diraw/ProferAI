/**
 * 契约测试：事件流与断线恢复
 * 验收点：序列单调、eventId 去重、游标恢复不丢不重。
 */

import { describe, expect, it } from 'bun:test'
import {
  TaskEventType,
  createInMemoryEventLog,
} from './index'

describe('事件日志', () => {
  it('同一任务内 eventSequence 从 1 单调递增', () => {
    const log = createInMemoryEventLog()
    const e1 = log.append({ eventId: 'e1', taskId: 't1', type: TaskEventType.CREATED, occurredAt: 1, producerAgentId: 'gw', payload: {} })
    const e2 = log.append({ eventId: 'e2', taskId: 't1', type: TaskEventType.STARTED, occurredAt: 2, producerAgentId: 'gw', payload: {} })
    const e3 = log.append({ eventId: 'e3', taskId: 't1', type: TaskEventType.PROGRESS, occurredAt: 3, producerAgentId: 'gw', payload: {} })
    expect([e1.eventSequence, e2.eventSequence, e3.eventSequence]).toEqual([1, 2, 3])
  })

  it('不同任务的序列互相独立', () => {
    const log = createInMemoryEventLog()
    log.append({ eventId: 'e1', taskId: 't1', type: TaskEventType.CREATED, occurredAt: 1, producerAgentId: 'gw', payload: {} })
    const other = log.append({ eventId: 'e2', taskId: 't2', type: TaskEventType.CREATED, occurredAt: 2, producerAgentId: 'gw', payload: {} })
    expect(other.eventSequence).toBe(1)
  })

  it('同一 eventId 重复投递被去重，不产生新序列', () => {
    const log = createInMemoryEventLog()
    const first = log.append({ eventId: 'e1', taskId: 't1', type: TaskEventType.PROGRESS, occurredAt: 1, producerAgentId: 'gw', payload: { n: 1 } })
    const dup = log.append({ eventId: 'e1', taskId: 't1', type: TaskEventType.PROGRESS, occurredAt: 1, producerAgentId: 'gw', payload: { n: 1 } })
    expect(dup).toBe(first)
    expect(log.listByTask('t1')).toHaveLength(1)
  })

  it('断线后用游标恢复，只拿到之后的事件', () => {
    const log = createInMemoryEventLog()
    log.append({ eventId: 'e1', taskId: 't1', type: TaskEventType.CREATED, occurredAt: 1, producerAgentId: 'gw', payload: {} })
    log.append({ eventId: 'e2', taskId: 't1', type: TaskEventType.STARTED, occurredAt: 2, producerAgentId: 'gw', payload: {} })
    log.append({ eventId: 'e3', taskId: 't1', type: TaskEventType.COMPLETED, occurredAt: 3, producerAgentId: 'gw', payload: {} })

    const resumed = log.resumeAfter({ taskId: 't1', lastEventSequence: 1 })
    expect(resumed.map((event) => event.eventId)).toEqual(['e2', 'e3'])

    const none = log.resumeAfter({ taskId: 't1', lastEventSequence: 3 })
    expect(none).toHaveLength(0)
  })

  it('游标越界（对未来序列）报错而不是静默丢事件', () => {
    const log = createInMemoryEventLog()
    log.append({ eventId: 'e1', taskId: 't1', type: TaskEventType.CREATED, occurredAt: 1, producerAgentId: 'gw', payload: {} })
    expect(() => log.resumeAfter({ taskId: 't1', lastEventSequence: 5 })).toThrow()
  })
})
