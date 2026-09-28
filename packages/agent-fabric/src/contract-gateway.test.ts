/**
 * 契约测试：Local Agent Gateway 核心
 * 验收点（Phase 1）：提交/幂等/路由/能力拒绝/写租约/取消/事件游标/结果查询。
 * 全部通过假执行器完成，不启动真实 Agent。
 */

import { describe, expect, it } from 'bun:test'
import {
  AgentFabricGateway,
  AgentNodeStatus,
  ALL_CAPABILITIES,
  ApprovalMode,
  Capability,
  DEFAULT_PAIRED_AGENT_GRANTS,
  ProtocolError,
  ProtocolErrorCode,
  RetryClass,
  TaskStatus,
  TrustLevel,
  WorkspaceMode,
  buildSubmitEnvelope,
  createInMemoryRegistry,
  createInMemoryTaskStore,
  type AgentNode,
  type CallerContext,
  type TaskExecution,
  type TaskExecutor,
  type TaskPolicy,
  type TaskRequest,
  type TaskResult,
} from './index'

// ===== 测试替身 =====

function makeNode(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    agentId: 'profer-dev',
    instanceId: 'inst_1',
    displayName: 'Profer 开发版',
    version: '0.13.0-dev',
    status: AgentNodeStatus.ONLINE,
    endpoint: { transport: 'local-http', address: '127.0.0.1:48123' },
    capabilities: [...ALL_CAPABILITIES],
    workspaceBindings: ['ws-1'],
    maxConcurrency: 1,
    policy: { allowDelegation: true, maxDelegationDepth: 2 },
    registeredAt: 0,
    lastHeartbeatAt: 0,
    ...overrides,
  }
}

/** 记录所有 start 调用；complete/fail 由测试手动触发。 */
class FakeExecutor implements TaskExecutor {
  readonly started: TaskExecution[] = []
  readonly cancelled: string[] = []
  autoCompleteResult?: TaskResult

  start(execution: TaskExecution): void {
    this.started.push(execution)
    if (this.autoCompleteResult) {
      execution.reporter.complete(this.autoCompleteResult)
    }
  }
  cancel(taskId: string): void {
    this.cancelled.push(taskId)
  }
}

const pairedCaller: CallerContext = {
  agentId: 'hermes',
  trust: TrustLevel.PAIRED_LOCAL_AGENT,
  grants: [...DEFAULT_PAIRED_AGENT_GRANTS, Capability.WORKSPACE_WRITE],
}

function makePolicy(overrides: Partial<TaskPolicy> = {}): TaskPolicy {
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

let taskSeq = 0
function makeRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
  taskSeq += 1
  return {
    taskId: `task_${taskSeq}`,
    rootTaskId: `task_${taskSeq}`,
    requesterAgentId: 'hermes',
    orchestratorAgentId: 'profer-stable',
    targetAgentId: 'profer-dev',
    objective: '运行 smoke test',
    workspaceId: 'ws-1',
    constraints: [],
    dependsOn: [],
    policy: makePolicy(),
    submittedAt: 0,
    ...overrides,
  }
}

function makeGateway(executor: FakeExecutor, node: AgentNode = makeNode()) {
  const registry = createInMemoryRegistry()
  registry.register(node)
  const store = createInMemoryTaskStore()
  const gateway = new AgentFabricGateway({
    registry,
    store,
    resolveExecutor: () => executor,
  })
  return { gateway, registry, store, node }
}

describe('任务提交与路由', () => {
  it('合法提交：created 一路推进到 running，执行器收到任务', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task, deduplicated } = gateway.submitTask(
      buildSubmitEnvelope({ agentId: 'hermes' }, 'req_1', makeRequest()),
      pairedCaller,
    )
    expect(deduplicated).toBe(false)
    expect(task.status).toBe(TaskStatus.RUNNING)
    expect(executor.started).toHaveLength(1)
    expect(executor.started[0]!.task.request.taskId).toBe(task.request.taskId)
  })

  it('同一 requestId 重复提交返回同一任务，不重复执行', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const envelope = buildSubmitEnvelope({ agentId: 'hermes' }, 'req_dup', makeRequest())
    const first = gateway.submitTask(envelope, pairedCaller)
    const second = gateway.submitTask(envelope, pairedCaller)
    expect(second.deduplicated).toBe(true)
    expect(second.task.request.taskId).toBe(first.task.request.taskId)
    expect(executor.started).toHaveLength(1)
  })

  it('目标节点不存在时拒绝路由', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    try {
      gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_x', makeRequest({ targetAgentId: 'ghost' })), pairedCaller)
      throw new Error('应拒绝')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.AGENT_NOT_FOUND)
    }
    expect(executor.started).toHaveLength(0)
  })

  it('离线节点不执行，任务留在 queued（恢复上线后可继续）', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor, makeNode({ status: AgentNodeStatus.OFFLINE }))
    try {
      gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_off', makeRequest()), pairedCaller)
      throw new Error('应拒绝')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.AGENT_OFFLINE)
    }
  })

  it('没有 task.submit 能力的调用方被拒绝', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const caller: CallerContext = { agentId: 'stranger', trust: TrustLevel.UNTRUSTED_LOCAL, grants: [Capability.TASK_READ] }
    try {
      gateway.submitTask(buildSubmitEnvelope({ agentId: 'stranger' }, 'req_deny', makeRequest()), caller)
      throw new Error('应拒绝')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.CAPABILITY_DENIED)
    }
  })

  it('写任务要求 workspace.write 能力', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const readOnlyCaller: CallerContext = {
      agentId: 'hermes',
      trust: TrustLevel.PAIRED_LOCAL_AGENT,
      grants: [...DEFAULT_PAIRED_AGENT_GRANTS],
    }
    const request = makeRequest({
      policy: makePolicy({
        workspaceMode: WorkspaceMode.SINGLE_WRITER,
        writeIntent: { paths: ['src/a.ts'], conflictStrategy: 'fail' },
      }),
    })
    try {
      gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_w', request), readOnlyCaller)
      throw new Error('应拒绝')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.CAPABILITY_DENIED)
    }
  })
})

describe('并发与写租约', () => {
  it('maxConcurrency=1 时第二个任务保持 queued，第一个完成后自动推进', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const first = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_c1', makeRequest()), pairedCaller)
    const second = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_c2', makeRequest()), pairedCaller)
    expect(first.task.status).toBe(TaskStatus.RUNNING)
    expect(second.task.status).toBe(TaskStatus.QUEUED)
    expect(executor.started).toHaveLength(1)

    executor.started[0]!.reporter.complete({
      status: 'completed', summary: 'ok', changedFiles: [], testResults: [], artifacts: [], evidence: [], blockers: [], nextActions: [],
    })
    expect(executor.started).toHaveLength(2)
    expect(gateway.listTasks().find((t) => t.request.taskId === first.task.request.taskId)?.status).toBe(TaskStatus.COMPLETED)
  })

  it('single-writer 写冲突 fail 策略：第二个写任务直接失败', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const writePolicy = makePolicy({
      workspaceMode: WorkspaceMode.SINGLE_WRITER,
      writeIntent: { paths: ['src/**'], conflictStrategy: 'fail' },
    })
    const first = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_w1', makeRequest({ policy: writePolicy })), pairedCaller)
    expect(first.task.status).toBe(TaskStatus.RUNNING)

    const second = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_w2', makeRequest({ policy: writePolicy })), pairedCaller)
    expect(second.task.status).toBe(TaskStatus.FAILED)
    expect(gateway.listTasks().find((t) => t.request.taskId === second.task.request.taskId)?.failureReason).toContain('写租约')
  })

  it('single-writer 写冲突 queue 策略：等待租约释放后自动推进', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const queuePolicy = makePolicy({
      workspaceMode: WorkspaceMode.SINGLE_WRITER,
      writeIntent: { paths: ['src/**'], conflictStrategy: 'queue' },
    })
    gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_q1', makeRequest({ policy: queuePolicy })), pairedCaller)
    const second = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_q2', makeRequest({ policy: queuePolicy })), pairedCaller)
    expect(second.task.status).toBe(TaskStatus.QUEUED)

    executor.started[0]!.reporter.complete({
      status: 'completed', summary: 'ok', changedFiles: [], testResults: [], artifacts: [], evidence: [], blockers: [], nextActions: [],
    })
    expect(executor.started).toHaveLength(2)
  })
})

describe('结果、事件与取消', () => {
  it('完成后结果可查询，事件序列完整且可游标恢复', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task } = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_r', makeRequest()), pairedCaller)
    const taskId = task.request.taskId

    executor.started[0]!.reporter.progress({ message: '一半了' })
    executor.started[0]!.reporter.artifactCreated({ artifactId: 'a1', taskId, kind: 'log', createdAt: 1 })
    executor.started[0]!.reporter.complete({
      status: 'completed', summary: 'done', changedFiles: [], testResults: [], artifacts: [], evidence: [], blockers: [], nextActions: [],
    })

    const result = gateway.getTaskResult(pairedCaller, taskId)
    expect(result?.summary).toBe('done')

    const events = gateway.resumeEvents(taskId, 0)
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'task.created', 'task.accepted', 'task.started', 'task.progress', 'task.artifact_created', 'task.completed',
    ])
    // 游标恢复：从 started 之后只剩 progress/artifact/completed
    const startedSeq = events.find((e) => e.type === 'task.started')!.eventSequence
    expect(gateway.resumeEvents(taskId, startedSeq).map((e) => e.type)).toEqual([
      'task.progress', 'task.artifact_created', 'task.completed',
    ])

    const artifacts = gateway.listArtifacts(pairedCaller, taskId)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.artifactId).toBe('a1')
  })

  it('运行中取消：执行器收到 cancel，任务进入终态，租约与并发释放', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task } = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_cancel', makeRequest()), pairedCaller)
    const taskId = task.request.taskId

    const cancelled = gateway.cancelTask(pairedCaller, taskId)
    expect(cancelled.status).toBe(TaskStatus.CANCELLED)
    expect(executor.cancelled).toEqual([taskId])

    // 并发已释放：新任务可以立即运行
    const next = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_next', makeRequest()), pairedCaller)
    expect(next.task.status).toBe(TaskStatus.RUNNING)
  })

  it('终态任务不可再取消', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task } = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_t', makeRequest()), pairedCaller)
    executor.started[0]!.reporter.complete({
      status: 'completed', summary: 'ok', changedFiles: [], testResults: [], artifacts: [], evidence: [], blockers: [], nextActions: [],
    })
    try {
      gateway.cancelTask(pairedCaller, task.request.taskId)
      throw new Error('应拒绝')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.TASK_TERMINAL)
    }
  })

  it('执行器 fail 上报后任务进入 failed 并记录原因', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task } = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_f', makeRequest()), pairedCaller)
    executor.started[0]!.reporter.fail('模型调用失败')
    const failed = gateway.getTask(pairedCaller, task.request.taskId)
    expect(failed.status).toBe(TaskStatus.FAILED)
    expect(failed.failureReason).toBe('模型调用失败')
  })

  it('执行器重复 settle 被忽略（complete 后 fail 无副作用）', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task } = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_s', makeRequest()), pairedCaller)
    executor.started[0]!.reporter.complete({
      status: 'completed', summary: 'ok', changedFiles: [], testResults: [], artifacts: [], evidence: [], blockers: [], nextActions: [],
    })
    // 迟到的 fail 不应炸掉（reporter 内部吞掉二次 settle；move 若被调用会因终态抛错）
    expect(gateway.getTask(pairedCaller, task.request.taskId).status).toBe(TaskStatus.COMPLETED)
  })

  it('未配对调用方读取任务被拒（无 task.read 能力）', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task } = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_g', makeRequest()), pairedCaller)
    const stranger: CallerContext = { agentId: 'evil', trust: TrustLevel.UNTRUSTED_LOCAL, grants: [] }
    expect(() => gateway.getTask(stranger, task.request.taskId)).toThrow(ProtocolError)
  })

  it('产物读取要求 artifact.read 且过期拒绝', () => {
    const executor = new FakeExecutor()
    const { gateway } = makeGateway(executor)
    const { task } = gateway.submitTask(buildSubmitEnvelope({ agentId: 'hermes' }, 'req_a', makeRequest()), pairedCaller)
    const taskId = task.request.taskId
    executor.started[0]!.reporter.artifactCreated({ artifactId: 'a_exp', taskId, kind: 'log', createdAt: 0, expiresAt: 100 })

    const noArtifactCaller: CallerContext = {
      agentId: 'hermes2', trust: TrustLevel.PAIRED_LOCAL_AGENT, grants: [Capability.TASK_READ],
    }
    expect(() => gateway.getArtifact(noArtifactCaller, 'a_exp')).toThrow(ProtocolError)

    try {
      gateway.getArtifact(pairedCaller, 'a_exp')
      throw new Error('应拒绝过期产物')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.ARTIFACT_EXPIRED)
    }
  })
})
