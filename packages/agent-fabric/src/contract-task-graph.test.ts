/**
 * 契约测试：任务图与策略收窄
 * 验收点：子任务不能扩大父任务授权；深度/子数限制；DAG 依赖不跨图、不成环。
 */

import { describe, expect, it } from 'bun:test'
import {
  ApprovalMode,
  Capability,
  ProtocolError,
  ProtocolErrorCode,
  RetryClass,
  TaskStatus,
  WorkspaceMode,
  assertDelegationAllowed,
  assertDependsOnWithinGraph,
  assertNoDependencyCycle,
  narrowPolicy,
  type AgentTask,
  type ChildTaskLink,
  type TaskPolicy,
} from './index'

function parentPolicy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
  return {
    approvalMode: ApprovalMode.FORWARD_TO_USER,
    allowDelegation: true,
    maxDelegationDepth: 2,
    maxChildren: 3,
    timeoutSeconds: 1800,
    workspaceMode: WorkspaceMode.SINGLE_WRITER,
    writeIntent: { paths: ['src/**'], conflictStrategy: 'fail' },
    allowedCapabilities: [Capability.WORKSPACE_WRITE, Capability.TEST_RUN],
    retryClass: RetryClass.MANUAL_REVIEW_REQUIRED,
    ...overrides,
  }
}

function parentTask(policy: TaskPolicy = parentPolicy()): AgentTask {
  return {
    request: {
      taskId: 'task_root',
      rootTaskId: 'task_root',
      requesterAgentId: 'profer-stable',
      orchestratorAgentId: 'profer-stable',
      targetAgentId: 'profer-dev',
      objective: 'root',
      workspaceId: 'ws',
      constraints: [],
      dependsOn: [],
      policy,
      submittedAt: 0,
    },
    status: TaskStatus.RUNNING,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('策略收窄：只能继承或收窄', () => {
  it('子任务收窄深度与超时可通过', () => {
    const child = narrowPolicy(parentPolicy(), { maxDelegationDepth: 1, timeoutSeconds: 600 })
    expect(child.maxDelegationDepth).toBe(1)
    expect(child.timeoutSeconds).toBe(600)
    // 未声明项继承父级
    expect(child.workspaceMode).toBe(WorkspaceMode.SINGLE_WRITER)
  })

  it('子任务扩大委派深度被拒绝', () => {
    try {
      narrowPolicy(parentPolicy(), { maxDelegationDepth: 5 })
      throw new Error('应拒绝扩大')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.POLICY_WIDENING_REJECTED)
    }
  })

  it('子任务扩大能力白名单被拒绝', () => {
    try {
      narrowPolicy(parentPolicy(), { allowedCapabilities: [Capability.WORKSPACE_WRITE, Capability.EXTERNAL_PUBLISH] })
      throw new Error('应拒绝扩大能力')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.POLICY_WIDENING_REJECTED)
    }
  })

  it('子任务不能降低审批强度（forward_to_user 不可被绕过）', () => {
    try {
      narrowPolicy(parentPolicy(), { approvalMode: ApprovalMode.AUTO_DENY })
      throw new Error('应拒绝审批降级')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.POLICY_WIDENING_REJECTED)
    }
  })

  it('子任务从 single-writer 降到 isolated-writer 属于收窄，可通过', () => {
    const child = narrowPolicy(parentPolicy(), { workspaceMode: WorkspaceMode.ISOLATED_WRITER })
    expect(child.workspaceMode).toBe(WorkspaceMode.ISOLATED_WRITER)
  })

  it('子任务把 read-shared 升级为 single-writer 被拒绝', () => {
    const parent = parentPolicy({ workspaceMode: WorkspaceMode.READ_SHARED, writeIntent: undefined })
    try {
      narrowPolicy(parent, { workspaceMode: WorkspaceMode.SINGLE_WRITER })
      throw new Error('应拒绝工作区模式扩大')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.POLICY_WIDENING_REJECTED)
    }
  })
})

describe('委派边界', () => {
  it('深度到达上限后禁止继续派生', () => {
    try {
      assertDelegationAllowed({ parent: parentTask(), currentChildCount: 0, parentDepth: 2 })
      throw new Error('应拒绝超深委派')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.DELEGATION_DEPTH_EXCEEDED)
    }
  })

  it('子任务数到达上限后禁止继续派生', () => {
    try {
      assertDelegationAllowed({ parent: parentTask(), currentChildCount: 3, parentDepth: 0 })
      throw new Error('应拒绝超量派生')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.MAX_CHILDREN_EXCEEDED)
    }
  })

  it('allowDelegation=false 直接拒绝', () => {
    const parent = parentTask(parentPolicy({ allowDelegation: false, maxDelegationDepth: 0, maxChildren: 0 }))
    try {
      assertDelegationAllowed({ parent, currentChildCount: 0, parentDepth: 0 })
      throw new Error('应拒绝委派')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.POLICY_VIOLATION)
    }
  })
})

describe('DAG 依赖', () => {
  it('检测依赖环', () => {
    const edges = new Map<string, readonly string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ])
    try {
      assertNoDependencyCycle(edges)
      throw new Error('应检测出环')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.DEPENDENCY_CYCLE)
    }
  })

  it('无环 DAG 通过', () => {
    const edges = new Map<string, readonly string[]>([
      ['impl', ['analysis']],
      ['test', ['impl']],
      ['review', ['impl', 'test']],
    ])
    expect(() => assertNoDependencyCycle(edges)).not.toThrow()
  })

  it('依赖必须属于当前任务图，跨图依赖被拒绝', () => {
    const link: ChildTaskLink = {
      parentTaskId: 'task_root',
      rootTaskId: 'task_root',
      dependsOn: ['task_other_graph'],
      requesterAgentId: 'profer-stable',
      orchestratorAgentId: 'profer-stable',
      targetAgentId: 'profer-dev',
      aggregationMode: 'wait-all',
    }
    const graph = new Map<string, ReadonlySet<string>>([['task_root', new Set(['task_a', 'task_b'])]])
    try {
      assertDependsOnWithinGraph(link, graph)
      throw new Error('应拒绝跨图依赖')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.DEPENDENCY_NOT_FOUND)
    }
  })
})
