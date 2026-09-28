/**
 * 契约测试：任务请求校验
 * 验收点：请求结构、policy 自洽、敏感内容只走受控引用。
 */

import { describe, expect, it } from 'bun:test'
import {
  ApprovalMode,
  ProtocolError,
  ProtocolErrorCode,
  RetryClass,
  WorkspaceMode,
  validateTaskRequest,
  type TaskPolicy,
  type TaskRequest,
} from './index'

function basePolicy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return {
    approvalMode: ApprovalMode.FORWARD_TO_USER,
    allowDelegation: false,
    maxDelegationDepth: 0,
    maxChildren: 0,
    timeoutSeconds: 1800,
    workspaceMode: WorkspaceMode.READ_SHARED,
    retryClass: RetryClass.SAFE_TO_RETRY,
    ...overrides,
  }
}

function baseRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskId: 'task_1',
    rootTaskId: 'task_1',
    requesterAgentId: 'hermes',
    orchestratorAgentId: 'profer-stable',
    targetAgentId: 'profer-dev',
    objective: '运行 smoke test 并返回截图与日志',
    workspaceId: 'profer-main',
    constraints: [],
    dependsOn: [],
    policy: basePolicy(),
    submittedAt: 1_000,
    ...overrides,
  }
}

describe('任务请求校验', () => {
  it('接受合法的只读任务', () => {
    expect(() => validateTaskRequest(baseRequest())).not.toThrow()
  })

  it('拒绝空 objective', () => {
    expect(() => validateTaskRequest(baseRequest({ objective: ' ' }))).toThrow(ProtocolError)
  })

  it('拒绝缺失 workspaceId', () => {
    expect(() => validateTaskRequest(baseRequest({ workspaceId: '' }))).toThrow(ProtocolError)
  })

  it('拒绝 allowDelegation=false 但深度/子数非零的自相矛盾 policy', () => {
    const policy = basePolicy({ maxDelegationDepth: 2 })
    try {
      validateTaskRequest(baseRequest({ policy }))
      throw new Error('应抛出 policy 违规')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.POLICY_VIOLATION)
    }
  })

  it('拒绝 read-shared 模式声明写意图', () => {
    const policy = basePolicy({ writeIntent: { paths: ['src/a.ts'], conflictStrategy: 'fail' } })
    try {
      validateTaskRequest(baseRequest({ policy }))
      throw new Error('应抛出写意图违规')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.POLICY_VIOLATION)
    }
  })

  it('拒绝写模式任务缺失 writeIntent.paths', () => {
    const policy = basePolicy({ workspaceMode: WorkspaceMode.SINGLE_WRITER })
    expect(() => validateTaskRequest(baseRequest({ policy }))).toThrow(ProtocolError)
  })

  it('拒绝携带疑似敏感字段的上下文（apiKey 等只走受控引用）', () => {
    const request = baseRequest({
      context: { notes: 'ok', files: [], artifactIds: [], ...( { extra: { apiKey: 'sk-xxx' } } as object) } as TaskRequest['context'],
    })
    try {
      validateTaskRequest(request)
      throw new Error('应抛出敏感内容违规')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.SENSITIVE_INLINE_CONTENT)
    }
  })

  it('拒绝嵌套环境变量字段', () => {
    const request = baseRequest({
      context: { notes: 'x', ...( { nested: [{ env: { A: '1' } }] } as object) } as TaskRequest['context'],
    })
    try {
      validateTaskRequest(request)
      throw new Error('应抛出敏感内容违规')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.SENSITIVE_INLINE_CONTENT)
    }
  })

  it('合法的文件与产物引用上下文可以通过', () => {
    const request = baseRequest({
      context: { files: ['apps/electron/src/renderer/pages/Login.tsx'], artifactIds: ['artifact_prev'], notes: '参考上次分析' },
    })
    expect(() => validateTaskRequest(request)).not.toThrow()
  })
})
