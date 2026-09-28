/**
 * 文件持久化适配测试
 * 验收点：任务/结果/事件/requestId 索引跨实例（模拟重启）可恢复。
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalMode,
  RetryClass,
  TaskStatus,
  WorkspaceMode,
  type AgentTask,
} from '@profer/agent-fabric'
import { createFileEventLog, createFileTaskStore } from './fabric-store'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fabric-store-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function makeTask(taskId: string, status: (typeof TaskStatus)[keyof typeof TaskStatus] = TaskStatus.RUNNING): AgentTask {
  return {
    request: {
      taskId,
      rootTaskId: taskId,
      requesterAgentId: 'hermes',
      orchestratorAgentId: 'profer-stable',
      targetAgentId: 'profer-stable',
      objective: 'obj',
      workspaceId: 'ws',
      constraints: [],
      dependsOn: [],
      policy: {
        approvalMode: ApprovalMode.AUTO_DENY,
        allowDelegation: false,
        maxDelegationDepth: 0,
        maxChildren: 0,
        timeoutSeconds: 600,
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

describe('文件任务存储', () => {
  it('任务、结果、产物与 requestId 索引在新实例中可恢复（模拟进程重启）', () => {
    const store1 = createFileTaskStore(tempDir)
    const task = makeTask('task_persist')
    store1.save(task)
    store1.indexRequestId('req_persist', 'task_persist')
    store1.saveResult('task_persist', {
      status: 'completed', summary: 'done', changedFiles: [], testResults: [], artifacts: [], evidence: [], blockers: [], nextActions: [],
    })
    store1.saveArtifact({ artifactId: 'a1', taskId: 'task_persist', kind: 'log', createdAt: 1 })

    // 模拟重启：同一目录新实例
    const store2 = createFileTaskStore(tempDir)
    expect(store2.get('task_persist')?.status).toBe(TaskStatus.RUNNING)
    expect(store2.findByRequestId('req_persist')?.request.taskId).toBe('task_persist')
    expect(store2.getResult('task_persist')?.summary).toBe('done')
    expect(store2.listArtifacts('task_persist')).toHaveLength(1)

    // 状态更新也持久化
    store2.save({ ...task, status: TaskStatus.COMPLETED })
    const store3 = createFileTaskStore(tempDir)
    expect(store3.get('task_persist')?.status).toBe(TaskStatus.COMPLETED)
  })
})

describe('文件事件日志', () => {
  it('事件追加后新实例可回放，且序列不重置', () => {
    const log1 = createFileEventLog(tempDir)
    log1.append({ eventId: 'e1', taskId: 't1', type: 'task.created', occurredAt: 1, producerAgentId: 'gw', payload: {} })
    log1.append({ eventId: 'e2', taskId: 't1', type: 'task.started', occurredAt: 2, producerAgentId: 'gw', payload: {} })

    // 模拟重启：回放后继续追加，序列从 3 开始而不是重置为 1
    const log2 = createFileEventLog(tempDir)
    expect(log2.resumeAfter({ taskId: 't1', lastEventSequence: 0 })).toHaveLength(2)
    const e3 = log2.append({ eventId: 'e3', taskId: 't1', type: 'task.completed', occurredAt: 3, producerAgentId: 'gw', payload: {} })
    expect(e3.eventSequence).toBe(3)

    const log3 = createFileEventLog(tempDir)
    const all = log3.resumeAfter({ taskId: 't1', lastEventSequence: 0 })
    expect(all.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3'])
  })

  it('重复 eventId 不重复追加', () => {
    const log = createFileEventLog(tempDir)
    const first = log.append({ eventId: 'e1', taskId: 't1', type: 'task.progress', occurredAt: 1, producerAgentId: 'gw', payload: {} })
    const dup = log.append({ eventId: 'e1', taskId: 't1', type: 'task.progress', occurredAt: 1, producerAgentId: 'gw', payload: {} })
    expect(dup).toBe(first)
    expect(log.listByTask('t1')).toHaveLength(1)
  })
})
