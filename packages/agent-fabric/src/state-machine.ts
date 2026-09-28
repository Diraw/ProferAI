/**
 * Task 状态机
 *
 * 设计文档 §5.2 的迁移表实现。要点：
 * - waiting_for_approval / waiting_for_input 不是失败，必须保留恢复上下文；
 * - 终态（completed/failed/cancelled/expired）之后禁止任何迁移；
 * - 状态判断只看状态字段，不解析自然语言事件文本。
 */

import { ProtocolError, ProtocolErrorCode } from './protocol'
import { TaskStatus, type AgentTask, type TaskStatusValue } from './task'

/** 终态集合。 */
export const TERMINAL_STATUSES: readonly TaskStatusValue[] = [
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.EXPIRED,
]

export function isTerminalStatus(status: TaskStatusValue): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** 可恢复等待态：从这两种状态恢复时必须同时恢复 pendingApprovalId / pendingInputRequestId 上下文。 */
export const RESUMABLE_WAITING_STATUSES: readonly TaskStatusValue[] = [
  TaskStatus.WAITING_FOR_APPROVAL,
  TaskStatus.WAITING_FOR_INPUT,
]

export function isResumableWaitingStatus(status: TaskStatusValue): boolean {
  return RESUMABLE_WAITING_STATUSES.includes(status)
}

/**
 * 合法迁移表（与设计文档 §5.2 逐条对应）：
 * 正常路径 created -> queued -> routing -> accepted -> running -> (delegating/waiting_for_children) -> running -> completed；
 * 异常路径见各 waiting/paused 分支与“任何可运行状态 -> failed/cancelled/expired”。
 */
const TRANSITIONS: Readonly<Record<TaskStatusValue, readonly TaskStatusValue[]>> = {
  [TaskStatus.CREATED]: [TaskStatus.QUEUED, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  // queued -> failed：调度准入失败（写租约冲突 fail 策略、无可用执行器）发生在 queued，
  // 属于设计文档「任何可运行状态 -> failed」的细化。
  [TaskStatus.QUEUED]: [TaskStatus.ROUTING, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  [TaskStatus.ROUTING]: [TaskStatus.ACCEPTED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  [TaskStatus.ACCEPTED]: [TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  [TaskStatus.RUNNING]: [
    TaskStatus.DELEGATING,
    TaskStatus.WAITING_FOR_CHILDREN,
    TaskStatus.WAITING_FOR_APPROVAL,
    TaskStatus.WAITING_FOR_INPUT,
    TaskStatus.PAUSED,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.EXPIRED,
  ],
  [TaskStatus.DELEGATING]: [
    TaskStatus.RUNNING,
    TaskStatus.WAITING_FOR_CHILDREN,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.EXPIRED,
  ],
  [TaskStatus.WAITING_FOR_CHILDREN]: [TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  [TaskStatus.WAITING_FOR_APPROVAL]: [TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  [TaskStatus.WAITING_FOR_INPUT]: [TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  [TaskStatus.PAUSED]: [TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.EXPIRED],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.FAILED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.EXPIRED]: [],
}

export function canTransition(from: TaskStatusValue, to: TaskStatusValue): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/** 断言迁移合法，否则抛 INVALID_STATE_TRANSITION / TASK_TERMINAL。 */
export function assertTransition(from: TaskStatusValue, to: TaskStatusValue): void {
  if (isTerminalStatus(from)) {
    throw new ProtocolError(
      ProtocolErrorCode.TASK_TERMINAL,
      `任务已处于终态 ${from}，禁止再迁移到 ${to}`,
      { details: { from, to } },
    )
  }
  if (!canTransition(from, to)) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_STATE_TRANSITION,
      `非法状态迁移：${from} -> ${to}`,
      { details: { from, to } },
    )
  }
}

/**
 * 执行迁移并返回更新后的任务（不可变更新）。
 * 进入等待态时要求携带对应 pending 上下文；离开等待态时自动清除。
 */
export function transitionTask(
  task: AgentTask,
  to: TaskStatusValue,
  at: number,
  opts?: { pendingApprovalId?: string; pendingInputRequestId?: string; failureReason?: string },
): AgentTask {
  assertTransition(task.status, to)

  if (to === TaskStatus.WAITING_FOR_APPROVAL && !opts?.pendingApprovalId) {
    throw new ProtocolError(
      ProtocolErrorCode.VALIDATION_FAILED,
      '进入 waiting_for_approval 必须携带 pendingApprovalId（恢复上下文必需）',
    )
  }
  if (to === TaskStatus.WAITING_FOR_INPUT && !opts?.pendingInputRequestId) {
    throw new ProtocolError(
      ProtocolErrorCode.VALIDATION_FAILED,
      '进入 waiting_for_input 必须携带 pendingInputRequestId（恢复上下文必需）',
    )
  }

  const next: AgentTask = {
    ...task,
    status: to,
    updatedAt: at,
    pendingApprovalId: to === TaskStatus.WAITING_FOR_APPROVAL ? opts?.pendingApprovalId : undefined,
    pendingInputRequestId: to === TaskStatus.WAITING_FOR_INPUT ? opts?.pendingInputRequestId : undefined,
    failureReason: to === TaskStatus.FAILED ? (opts?.failureReason ?? task.failureReason) : task.failureReason,
  }
  return next
}
