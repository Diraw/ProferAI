/**
 * 契约测试：任务状态机
 * 验收点：状态迁移合法路径、非法迁移拒絶、终态封闭、等待态保留恢复上下文。
 */

import { describe, expect, it } from 'bun:test'
import {
  ApprovalMode,
  ProtocolError,
  ProtocolErrorCode,
  RetryClass,
  TaskStatus,
  WorkspaceMode,
  canTransition,
  isResumableWaitingStatus,
  isTerminalStatus,
  transitionTask,
  type AgentTask,
} from './index'

function makeTask(status: (typeof TaskStatus)[keyof typeof TaskStatus] = TaskStatus.CREATED): AgentTask {
  return {
    request: {
      taskId: 'task_1',
      rootTaskId: 'task_1',
      requesterAgentId: 'hermes',
      orchestratorAgentId: 'profer-stable',
      targetAgentId: 'profer-dev',
      objective: 'obj',
      workspaceId: 'ws',
      constraints: [],
      dependsOn: [],
      policy: {
        approvalMode: ApprovalMode.FORWARD_TO_USER,
        allowDelegation: true,
        maxDelegationDepth: 2,
        maxChildren: 3,
        timeoutSeconds: 1800,
        workspaceMode: WorkspaceMode.READ_SHARED,
        retryClass: RetryClass.SAFE_TO_RETRY,
      },
      submittedAt: 0,
    },
    status,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('状态机：正常路径', () => {
  it('created -> queued -> routing -> accepted -> running -> completed', () => {
    let task = makeTask()
    task = transitionTask(task, TaskStatus.QUEUED, 1)
    task = transitionTask(task, TaskStatus.ROUTING, 2)
    task = transitionTask(task, TaskStatus.ACCEPTED, 3)
    task = transitionTask(task, TaskStatus.RUNNING, 4)
    task = transitionTask(task, TaskStatus.COMPLETED, 5)
    expect(task.status).toBe(TaskStatus.COMPLETED)
    expect(task.updatedAt).toBe(5)
  })

  it('running -> delegating -> waiting_for_children -> running -> completed（委派聚合路径）', () => {
    let task = makeTask(TaskStatus.RUNNING)
    task = transitionTask(task, TaskStatus.DELEGATING, 1)
    task = transitionTask(task, TaskStatus.WAITING_FOR_CHILDREN, 2)
    task = transitionTask(task, TaskStatus.RUNNING, 3)
    task = transitionTask(task, TaskStatus.COMPLETED, 4)
    expect(task.status).toBe(TaskStatus.COMPLETED)
  })

  it('waiting_for_approval 保留并恢复 pendingApprovalId', () => {
    let task = makeTask(TaskStatus.RUNNING)
    task = transitionTask(task, TaskStatus.WAITING_FOR_APPROVAL, 1, { pendingApprovalId: 'appr_1' })
    expect(task.pendingApprovalId).toBe('appr_1')
    expect(isResumableWaitingStatus(task.status)).toBe(true)

    task = transitionTask(task, TaskStatus.RUNNING, 2)
    expect(task.pendingApprovalId).toBeUndefined()
  })

  it('paused -> running 恢复执行', () => {
    let task = makeTask(TaskStatus.RUNNING)
    task = transitionTask(task, TaskStatus.PAUSED, 1)
    task = transitionTask(task, TaskStatus.RUNNING, 2)
    expect(task.status).toBe(TaskStatus.RUNNING)
  })
})

describe('状态机：非法迁移', () => {
  it('created 不能直接跳到 running', () => {
    expect(canTransition(TaskStatus.CREATED, TaskStatus.RUNNING)).toBe(false)
    try {
      transitionTask(makeTask(), TaskStatus.RUNNING, 1)
      throw new Error('应拒绝非法迁移')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_STATE_TRANSITION)
    }
  })

  it('终态之后禁止任何迁移', () => {
    for (const terminal of [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.EXPIRED] as const) {
      expect(isTerminalStatus(terminal)).toBe(true)
      try {
        transitionTask(makeTask(terminal), TaskStatus.RUNNING, 1)
        throw new Error('终态不应可迁移')
      } catch (error) {
        expect((error as ProtocolError).code).toBe(ProtocolErrorCode.TASK_TERMINAL)
      }
    }
  })

  it('进入 waiting_for_approval 必须携带 pendingApprovalId', () => {
    try {
      transitionTask(makeTask(TaskStatus.RUNNING), TaskStatus.WAITING_FOR_APPROVAL, 1)
      throw new Error('应要求审批上下文')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.VALIDATION_FAILED)
    }
  })

  it('queued 可以 expired（排队超时路径）', () => {
    const task = transitionTask(makeTask(TaskStatus.QUEUED), TaskStatus.EXPIRED, 1)
    expect(task.status).toBe(TaskStatus.EXPIRED)
  })
})
