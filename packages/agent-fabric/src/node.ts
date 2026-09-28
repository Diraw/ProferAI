/**
 * Agent Node 模型与注册表契约
 *
 * 语义要点：
 * - agentId 是稳定逻辑身份（路由/授权用），instanceId 是本次进程身份（可随重启变化）；
 * - 注册信息不直接授予能力，能力仍需在每次调用时按 grant ∩ policy 重新解析；
 * - 同一安装可暴露多个逻辑节点，但每个节点必须有独立的端口、数据目录与权限策略。
 */

import type { CapabilityValue } from './capabilities'
import { ProtocolError, ProtocolErrorCode } from './protocol'

export const AgentNodeStatus = {
  ONLINE: 'online',
  BUSY: 'busy',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
} as const

export type AgentNodeStatusValue = (typeof AgentNodeStatus)[keyof typeof AgentNodeStatus]

/** 传输类型即适配器类型；协议本体与传输无关。 */
export const EndpointTransport = {
  LOCAL_HTTP: 'local-http',
  IN_PROCESS: 'in-process',
  MCP: 'mcp',
  REMOTE_SERVER: 'remote-server',
} as const

export type EndpointTransportValue = (typeof EndpointTransport)[keyof typeof EndpointTransport]

export interface AgentEndpoint {
  transport: EndpointTransportValue
  /**
   * 传输地址。第一阶段只允许 127.0.0.1；
   * 绑定 LAN / Tailscale / 反代必须显式配置并有独立认证策略（本契约不表达，由 Gateway 配置层承担）。
   */
  address?: string
}

/** 节点自身的委派边界（注册信息的一部分，仍会被任务 policy 继续收窄）。 */
export interface AgentNodePolicy {
  allowDelegation: boolean
  maxDelegationDepth: number
}

export interface AgentNode {
  agentId: string
  instanceId: string
  displayName: string
  /** 用于能力与协议兼容判断，不作为身份。 */
  version: string
  status: AgentNodeStatusValue
  endpoint: AgentEndpoint
  capabilities: readonly CapabilityValue[]
  workspaceBindings: readonly string[]
  preset?: string
  maxConcurrency: number
  policy: AgentNodePolicy
  registeredAt: number
  lastHeartbeatAt: number
}

/** Stable / Dev / Headless 的固定逻辑身份。路由与授权只允许通过这些 agentId 寻址。 */
export const WELL_KNOWN_AGENT_IDS = {
  STABLE: 'profer-stable',
  DEV: 'profer-dev',
  LOCAL_HEADLESS: 'local-headless',
} as const

export type NodeProfileKind = 'stable' | 'dev' | 'test' | 'headless'

/**
 * 节点运行 Profile：Stable/Dev 测试闭环要求 Dev 拥有完全独立的运行边界。
 * 任何两项相同都视为同一安全边界，禁止拆成两个逻辑节点。
 */
export interface NodeProfile {
  agentId: string
  kind: NodeProfileKind
  port: number
  userDataDir: string
  sessionDir: string
  logDir: string
  /** 独立 workspace 路径或 git worktree 路径。 */
  workspacePath?: string
}

/** 校验两个 Profile 的运行边界完全隔离；违反时抛 POLICY_VIOLATION。 */
export function assertProfileIsolation(a: NodeProfile, b: NodeProfile): void {
  const conflicts: string[] = []
  if (a.port === b.port) conflicts.push(`port=${a.port}`)
  if (a.userDataDir === b.userDataDir) conflicts.push(`userDataDir=${a.userDataDir}`)
  if (a.sessionDir === b.sessionDir) conflicts.push(`sessionDir=${a.sessionDir}`)
  if (a.logDir === b.logDir) conflicts.push(`logDir=${a.logDir}`)
  if (a.workspacePath && a.workspacePath === b.workspacePath) conflicts.push(`workspacePath=${a.workspacePath}`)
  if (conflicts.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.POLICY_VIOLATION,
      `节点 ${a.agentId} 与 ${b.agentId} 缺少独立运行边界：${conflicts.join('、')}`,
      { details: { conflicts } },
    )
  }
}

// ===== 本地配对 =====

/** 已配对调用方记录。凭据只存引用，永不写入日志/导出/自然语言上下文。 */
export interface PairedClient {
  clientId: string
  clientName: string
  /** 公钥或凭据的受控引用（如系统钥匙串 key），不是凭据本体。 */
  credentialRef: string
  grants: readonly CapabilityValue[]
  createdAt: number
  lastSeenAt: number
  revokedAt?: number
}

/** 配对必须处于未撤销状态才允许任何操作。 */
export function assertPairingActive(client: PairedClient, now: number = Date.now()): void {
  if (client.revokedAt !== undefined && client.revokedAt <= now) {
    throw new ProtocolError(
      ProtocolErrorCode.PAIRING_REVOKED,
      `调用方 ${client.clientName}（${client.clientId}）的配对已撤销，新请求立即拒绝`,
    )
  }
}

// ===== 注册表契约 =====

/** 任务 payload 不允许自带任意 URL：目标解析只能走注册表。 */
export interface AgentRegistry {
  register(node: AgentNode): void
  heartbeat(agentId: string, instanceId: string, at: number): void
  deregister(agentId: string, instanceId: string): void
  get(agentId: string): AgentNode | undefined
  discover(filter?: { capability?: CapabilityValue; status?: AgentNodeStatusValue }): AgentNode[]
}

/**
 * 进程内注册表实现。
 * 仅用于 Phase 0 契约测试与同进程 headless 适配；跨进程发现由 Phase 1 Gateway 实现，
 * 但对上必须保持同一 AgentRegistry 语义。
 *
 * 防误用：deregister/heartbeat 必须同时匹配 agentId + instanceId，
 * 避免旧实例的迟到心跳覆盖新实例的注册。
 */
export function createInMemoryRegistry(): AgentRegistry {
  const nodes = new Map<string, AgentNode>()

  return {
    register(node) {
      nodes.set(node.agentId, node)
    },
    heartbeat(agentId, instanceId, at) {
      const node = nodes.get(agentId)
      if (!node || node.instanceId !== instanceId) return
      node.lastHeartbeatAt = at
    },
    deregister(agentId, instanceId) {
      const node = nodes.get(agentId)
      if (!node || node.instanceId !== instanceId) return
      nodes.set(agentId, { ...node, status: AgentNodeStatus.OFFLINE })
    },
    get(agentId) {
      return nodes.get(agentId)
    },
    discover(filter) {
      return [...nodes.values()].filter((node) => {
        if (filter?.status && node.status !== filter.status) return false
        if (filter?.capability && !node.capabilities.includes(filter.capability)) return false
        return true
      })
    },
  }
}

/** 路由前置断言：节点存在且可接受任务。 */
export function assertNodeRoutable(node: AgentNode | undefined, agentId: string): AgentNode {
  if (!node) {
    throw new ProtocolError(ProtocolErrorCode.AGENT_NOT_FOUND, `注册表中不存在 Agent 节点 ${agentId}`)
  }
  if (node.status === AgentNodeStatus.OFFLINE) {
    throw new ProtocolError(ProtocolErrorCode.AGENT_OFFLINE, `Agent 节点 ${agentId} 已离线`, { retryable: true })
  }
  return node
}
