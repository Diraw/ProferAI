/**
 * 契约测试：权限、配对、审批与产物
 * 验收点：权限拒绝（grant ∩ 节点能力 ∩ policy）、Profile 隔离、
 * 审批一次性 token 不可重放、产物过期拒绝。
 */

import { describe, expect, it } from 'bun:test'
import {
  ALL_CAPABILITIES,
  ApprovalTokenLedger,
  CAPABILITY_READINESS,
  Capability,
  DEFAULT_PAIRED_AGENT_GRANTS,
  NEVER_DEFAULT_GRANTED,
  PROTOCOL_VERSION,
  ProtocolError,
  ProtocolErrorCode,
  TrustLevel,
  assertApprovalConsumable,
  assertArtifactReadable,
  assertCapability,
  assertNodeRoutable,
  assertPairingActive,
  assertProfileIsolation,
  createInMemoryRegistry,
  findResultInconsistencies,
  resolveEffectiveCapabilities,
  AgentNodeStatus,
  type AgentNode,
  type ApprovalRequest,
  type NodeProfile,
  type PairedClient,
} from './index'

function makeNode(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    agentId: 'profer-dev',
    instanceId: 'inst_1',
    displayName: 'Profer 开发版',
    version: '0.13.0-dev',
    status: AgentNodeStatus.ONLINE,
    endpoint: { transport: 'local-http', address: '127.0.0.1:48123' },
    capabilities: [...ALL_CAPABILITIES],
    workspaceBindings: ['profer-main'],
    maxConcurrency: 1,
    policy: { allowDelegation: true, maxDelegationDepth: 2 },
    registeredAt: 0,
    lastHeartbeatAt: 0,
    ...overrides,
  }
}

describe('能力解析：grant ∩ 节点能力 ∩ policy', () => {
  it('Hermes 默认 grant 不包含审批/重启/写/外发', () => {
    for (const cap of NEVER_DEFAULT_GRANTED) {
      expect(DEFAULT_PAIRED_AGENT_GRANTS).not.toContain(cap)
      expect(CAPABILITY_READINESS[cap]).toBe('requires-explicit-grant')
    }
  })

  it('未授予 workspace.write 的调用方即使节点支持也被拒绝', () => {
    expect(() =>
      assertCapability(
        {
          callerGrants: DEFAULT_PAIRED_AGENT_GRANTS,
          callerTrust: TrustLevel.PAIRED_LOCAL_AGENT,
          nodeCapabilities: [...ALL_CAPABILITIES],
        },
        Capability.WORKSPACE_WRITE,
      ),
    ).toThrow(ProtocolError)
  })

  it('internal-only 能力对外部配对调用方不可见', () => {
    const effective = resolveEffectiveCapabilities({
      callerGrants: [Capability.SHELL_RUN, Capability.TASK_READ],
      callerTrust: TrustLevel.PAIRED_LOCAL_AGENT,
      nodeCapabilities: [...ALL_CAPABILITIES],
    })
    expect(effective.has(Capability.SHELL_RUN)).toBe(false)
    expect(effective.has(Capability.TASK_READ)).toBe(true)
  })

  it('internal-only 能力对 same-instance 调用方可用', () => {
    const effective = resolveEffectiveCapabilities({
      callerGrants: [Capability.SHELL_RUN],
      callerTrust: TrustLevel.SAME_INSTANCE,
      nodeCapabilities: [...ALL_CAPABILITIES],
    })
    expect(effective.has(Capability.SHELL_RUN)).toBe(true)
  })

  it('任务 policy 白名单继续收窄 grant', () => {
    const effective = resolveEffectiveCapabilities({
      callerGrants: [Capability.TASK_READ, Capability.TASK_CANCEL],
      callerTrust: TrustLevel.PAIRED_LOCAL_AGENT,
      nodeCapabilities: [...ALL_CAPABILITIES],
      policyAllowedCapabilities: [Capability.TASK_READ],
    })
    expect(effective.has(Capability.TASK_CANCEL)).toBe(false)
  })
})

describe('节点注册与 Profile 隔离', () => {
  it('注册表按 agentId 路由，缺失节点抛 AGENT_NOT_FOUND', () => {
    const registry = createInMemoryRegistry()
    expect(() => assertNodeRoutable(registry.get('ghost'), 'ghost')).toThrow(ProtocolError)
  })

  it('离线节点拒绝路由（可重试）', () => {
    const registry = createInMemoryRegistry()
    registry.register(makeNode({ status: AgentNodeStatus.OFFLINE }))
    try {
      assertNodeRoutable(registry.get('profer-dev'), 'profer-dev')
      throw new Error('应拒绝离线节点')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.AGENT_OFFLINE)
      expect((error as ProtocolError).retryable).toBe(true)
    }
  })

  it('旧实例的迟到心跳不能覆盖新实例', () => {
    const registry = createInMemoryRegistry()
    registry.register(makeNode({ instanceId: 'inst_new', lastHeartbeatAt: 100 }))
    registry.heartbeat('profer-dev', 'inst_old', 200)
    expect(registry.get('profer-dev')?.lastHeartbeatAt).toBe(100)
    registry.heartbeat('profer-dev', 'inst_new', 200)
    expect(registry.get('profer-dev')?.lastHeartbeatAt).toBe(200)
  })

  it('Stable/Dev 共享端口或数据目录被视为同一安全边界，拒绝注册', () => {
    const stable: NodeProfile = {
      agentId: 'profer-stable', kind: 'stable', port: 48123,
      userDataDir: '/u/stable', sessionDir: '/s/stable', logDir: '/l/stable',
    }
    const dev: NodeProfile = {
      agentId: 'profer-dev', kind: 'dev', port: 48123,
      userDataDir: '/u/stable', sessionDir: '/s/dev', logDir: '/l/dev',
    }
    expect(() => assertProfileIsolation(stable, dev)).toThrow(ProtocolError)
  })

  it('完全隔离的 Stable/Dev Profile 通过', () => {
    const stable: NodeProfile = {
      agentId: 'profer-stable', kind: 'stable', port: 48123,
      userDataDir: '/u/stable', sessionDir: '/s/stable', logDir: '/l/stable', workspacePath: '/w/main',
    }
    const dev: NodeProfile = {
      agentId: 'profer-dev', kind: 'dev', port: 48124,
      userDataDir: '/u/dev', sessionDir: '/s/dev', logDir: '/l/dev', workspacePath: '/w/worktree-dev',
    }
    expect(() => assertProfileIsolation(stable, dev)).not.toThrow()
  })

  it('撤销配对后新请求立即拒绝', () => {
    const client: PairedClient = {
      clientId: 'c1', clientName: 'hermes', credentialRef: 'keychain:profer/hermes',
      grants: DEFAULT_PAIRED_AGENT_GRANTS, createdAt: 0, lastSeenAt: 0, revokedAt: 100,
    }
    try {
      assertPairingActive(client, 200)
      throw new Error('应拒绝已撤销配对')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.PAIRING_REVOKED)
    }
  })
})

describe('审批绑定与一次性 token', () => {
  const request: ApprovalRequest = {
    approvalId: 'appr_1',
    taskId: 'task_child',
    rootTaskId: 'task_root',
    requesterAgentId: 'hermes',
    targetAgentId: 'profer-dev',
    workspaceScope: 'profer-main',
    capability: Capability.RUNTIME_RESTART,
    operationSummary: '重启开发版实例',
    expiresAt: 10_000,
    createdAt: 0,
    protocolVersion: PROTOCOL_VERSION,
  }
  const context = {
    taskId: 'task_child',
    rootTaskId: 'task_root',
    targetAgentId: 'profer-dev',
    workspaceScope: 'profer-main',
    capability: Capability.RUNTIME_RESTART,
    protocolVersion: PROTOCOL_VERSION,
  }

  it('绑定完全匹配且未过期时可消费', () => {
    expect(() => assertApprovalConsumable(request, context, 5_000)).not.toThrow()
  })

  it('审批过期必须重新请求', () => {
    try {
      assertApprovalConsumable(request, context, 10_001)
      throw new Error('应拒绝过期审批')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.APPROVAL_EXPIRED)
    }
  })

  it('跨任务使用被拒绝（绑定失配）', () => {
    try {
      assertApprovalConsumable(request, { ...context, taskId: 'task_other' }, 5_000)
      throw new Error('应拒绝跨任务使用')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.APPROVAL_BINDING_MISMATCH)
    }
  })

  it('跨 Agent 使用被拒绝', () => {
    try {
      assertApprovalConsumable(request, { ...context, targetAgentId: 'profer-stable' }, 5_000)
      throw new Error('应拒绝跨 Agent 使用')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.APPROVAL_BINDING_MISMATCH)
    }
  })

  it('一次性 token 不可重放', () => {
    const ledger = new ApprovalTokenLedger()
    const decision = { approvalId: 'appr_1', decision: 'approved' as const, decidedBy: 'user' as const, decidedAt: 1_000, oneTimeToken: 'tok_1' }
    expect(() => ledger.consume(decision, request)).not.toThrow()
    try {
      ledger.consume(decision, request)
      throw new Error('应拒绝重放')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.APPROVAL_REPLAY)
    }
  })

  it('decision 与 request 不绑定（approvalId 不符）直接拒绝', () => {
    const ledger = new ApprovalTokenLedger()
    const decision = { approvalId: 'appr_other', decision: 'approved' as const, decidedBy: 'user' as const, decidedAt: 1_000, oneTimeToken: 'tok_x' }
    try {
      ledger.consume(decision, request)
      throw new Error('应拒绝绑定不符')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.APPROVAL_BINDING_MISMATCH)
    }
  })
})

describe('产物与结果一致性', () => {
  it('过期产物拒绝读取', () => {
    try {
      assertArtifactReadable({ artifactId: 'a1', taskId: 't1', kind: 'log', createdAt: 0, expiresAt: 100 }, 200)
      throw new Error('应拒绝过期产物')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.ARTIFACT_EXPIRED)
    }
  })

  it('自称 completed 但有失败测试会被一致性检查暴露', () => {
    const issues = findResultInconsistencies({
      status: 'completed',
      summary: '测试通过',
      changedFiles: [],
      testResults: [{ command: 'bun test x', exitCode: 1, passed: 3, failed: 1 }],
      artifacts: [],
      evidence: [],
      blockers: [],
      nextActions: [],
    })
    expect(issues.length).toBeGreaterThan(0)
  })

  it('failed 但没有任何 blocker/失败测试也会被暴露', () => {
    const issues = findResultInconsistencies({
      status: 'failed',
      summary: '失败了',
      changedFiles: [],
      testResults: [],
      artifacts: [],
      evidence: [],
      blockers: [],
      nextActions: [],
    })
    expect(issues.length).toBeGreaterThan(0)
  })
})
