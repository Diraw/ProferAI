/**
 * 任务事件流契约
 *
 * 长任务不依赖一条常开的 HTTP 连接：事件按 taskId 持久化、按 eventSequence 排序，
 * 调用方断线后用 taskId + lastEventSequence 恢复订阅；eventId 负责重复投递去重。
 */

import { ProtocolError, ProtocolErrorCode } from './protocol'

export const TaskEventType = {
  CREATED: 'task.created',
  ACCEPTED: 'task.accepted',
  STARTED: 'task.started',
  PROGRESS: 'task.progress',
  CHILD_CREATED: 'task.child_created',
  CHILD_COMPLETED: 'task.child_completed',
  APPROVAL_REQUIRED: 'task.approval_required',
  ARTIFACT_CREATED: 'task.artifact_created',
  TEST_RESULT: 'task.test_result',
  PAUSED: 'task.paused',
  RESUMED: 'task.resumed',
  FAILED: 'task.failed',
  COMPLETED: 'task.completed',
  CANCELLED: 'task.cancelled',
  EXPIRED: 'task.expired',
} as const

export type TaskEventTypeValue = (typeof TaskEventType)[keyof typeof TaskEventType]

/**
 * 事件 envelope。payload 是结构化数据；
 * 协议不依赖自然语言事件文本判断任务状态（状态只看 Task.status）。
 */
export interface TaskEvent<TPayload = Record<string, unknown>> {
  eventId: string
  /** 同一 taskId 内单调递增，从 1 开始。 */
  eventSequence: number
  taskId: string
  type: TaskEventTypeValue
  occurredAt: number
  producerAgentId: string
  payload: TPayload
}

/** 断线恢复游标。 */
export interface EventCursor {
  taskId: string
  lastEventSequence: number
}

export interface AppendEventInput<TPayload = Record<string, unknown>> {
  eventId: string
  taskId: string
  type: TaskEventTypeValue
  occurredAt: number
  producerAgentId: string
  payload: TPayload
}

export interface TaskEventLog {
  /** 追加事件；同一 eventId 重复投递时返回已存在事件（幂等），不追加。 */
  append(input: AppendEventInput): TaskEvent
  /** 从游标之后恢复事件（不含游标本身），按 eventSequence 升序。 */
  resumeAfter(cursor: EventCursor): TaskEvent[]
  listByTask(taskId: string): TaskEvent[]
}

/**
 * 进程内事件日志实现，用于契约测试与同进程适配。
 * Phase 1 Gateway 的持久化实现必须保持同一语义：
 * 序列连续递增、eventId 去重、游标恢复不丢不重。
 */
export function createInMemoryEventLog(): TaskEventLog {
  const eventsByTask = new Map<string, TaskEvent[]>()
  const seenEventIds = new Map<string, TaskEvent>()

  return {
    append(input) {
      const duplicate = seenEventIds.get(input.eventId)
      if (duplicate) return duplicate

      const list = eventsByTask.get(input.taskId) ?? []
      const event: TaskEvent = {
        eventId: input.eventId,
        eventSequence: list.length + 1,
        taskId: input.taskId,
        type: input.type,
        occurredAt: input.occurredAt,
        producerAgentId: input.producerAgentId,
        payload: input.payload,
      }
      list.push(event)
      eventsByTask.set(input.taskId, list)
      seenEventIds.set(input.eventId, event)
      return event
    },
    resumeAfter(cursor) {
      const list = eventsByTask.get(cursor.taskId) ?? []
      const maxSeq = list.length
      if (cursor.lastEventSequence > maxSeq) {
        throw new ProtocolError(
          ProtocolErrorCode.VALIDATION_FAILED,
          `恢复游标越界：taskId=${cursor.taskId} lastEventSequence=${cursor.lastEventSequence}，当前最大 ${maxSeq}`,
        )
      }
      return list.filter((event) => event.eventSequence > cursor.lastEventSequence)
    },
    listByTask(taskId) {
      return [...(eventsByTask.get(taskId) ?? [])]
    },
  }
}
