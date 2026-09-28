/**
 * Agent Fabric 本地服务装配
 *
 * 组装顺序：配置 → 文件持久化（任务/事件）→ Gateway（含本节点注册）→
 * Headless 执行器 → Loopback HTTP/SSE 传输。
 * 启动时先执行孤儿任务恢复（所有非终态任务按 §12 策略过期，safe-to-retry 排队任务保留），
 * 再开始接受新请求。
 */

import { randomUUID, createHash } from 'node:crypto'
import {
  AgentFabricGateway,
  AgentNodeStatus,
  ALL_CAPABILITIES,
  createInMemoryRegistry,
  type AgentNode,
  type ArtifactRef,
} from '@profer/agent-fabric'
import { getAgentSessionMessages } from '../agent-session-manager'
import { loadAgentFabricConfig, type AgentFabricConfig } from './fabric-config'
import { authenticateToken } from './fabric-pairing'
import { createFileEventLog, createFileTaskStore } from './fabric-store'
import { createHeadlessTaskExecutor } from './fabric-executor-headless'
import { startFabricServer, type FabricServerHandle } from './fabric-server'

interface FabricServiceState {
  gateway: AgentFabricGateway
  server: FabricServerHandle
  config: AgentFabricConfig
  instanceId: string
  heartbeatTimer: ReturnType<typeof setInterval>
}

let state: FabricServiceState | null = null

const HEARTBEAT_INTERVAL_MS = 10_000
const ARTIFACT_CONTENT_CHAR_LIMIT = 512 * 1024

function getAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    return app.getVersion()
  } catch {
    return '0.0.0-dev'
  }
}

/** 产物内容读取（受控）：只支持会话转录类产物，内容截断上限 512KB。 */
async function readArtifactContent(ref: ArtifactRef): Promise<{ content: string; mimeType: string } | null> {
  const prefix = 'session-transcript-'
  if (!ref.artifactId.startsWith(prefix)) return null
  const sessionId = ref.artifactId.slice(prefix.length)
  const messages = getAgentSessionMessages(sessionId)
  if (messages.length === 0) return null
  const content = messages
    .map((message) => `## ${message.role}（${new Date(message.createdAt).toISOString()}）\n\n${message.content}`)
    .join('\n\n---\n\n')
    .slice(0, ARTIFACT_CONTENT_CHAR_LIMIT)
  return { content, mimeType: 'text/markdown' }
}

export function getAgentFabricGateway(): AgentFabricGateway | null {
  return state?.gateway ?? null
}

export function isAgentFabricRunning(): boolean {
  return state !== null
}

/**
 * 启动 Agent Fabric 本地服务。
 * 未启用（PROFER_AGENT_FABRIC=1 或 agent-fabric.json enabled=true）时为 no-op。
 * @returns 监听地址（如 127.0.0.1:4788）；未启动返回 null
 */
export async function startAgentFabricService(): Promise<string | null> {
  if (state) return state.server.address

  const config = loadAgentFabricConfig()
  if (!config.enabled) {
    console.log('[AgentFabric] 未启用（设置 PROFER_AGENT_FABRIC=1 或 agent-fabric.json enabled=true）')
    return null
  }

  const instanceId = `instance_${Date.now()}_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 8)}`
  const registry = createInMemoryRegistry()
  const store = createFileTaskStore()
  const eventLog = createFileEventLog()
  const executor = createHeadlessTaskExecutor({ config })

  const gateway = new AgentFabricGateway({
    registry,
    store,
    eventLog,
    resolveExecutor: (node) => (node.agentId === config.agentId ? executor : undefined),
  })

  const selfNode: AgentNode = {
    agentId: config.agentId,
    instanceId,
    displayName: config.agentId === 'profer-dev' ? 'Profer 开发版' : 'Profer 稳定版',
    version: getAppVersion(),
    status: AgentNodeStatus.ONLINE,
    endpoint: { transport: 'local-http', address: `${config.host}:${config.port}` },
    capabilities: [...ALL_CAPABILITIES],
    workspaceBindings: [],
    maxConcurrency: 1,
    policy: { allowDelegation: true, maxDelegationDepth: 2 },
    registeredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  }
  gateway.registerNode(selfNode)

  // 节点重启恢复：先把历史非终态任务收敛为 expired（或保留 safe-to-retry 排队任务），再开闸。
  const expiredCount = gateway.expireOrphanedTasks(selfNode.agentId, '节点进程重启，任务无法原地恢复')
  if (expiredCount > 0) {
    console.log(`[AgentFabric] 节点重启恢复：${expiredCount} 个非终态任务已标记为 expired`)
  }

  const server = await startFabricServer({
    gateway,
    authenticate: (token) => authenticateToken(token),
    readArtifactContent,
    host: config.host,
    port: config.port,
  })

  const heartbeatTimer = setInterval(() => {
    gateway.heartbeat(selfNode.agentId, instanceId)
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

  state = { gateway, server, config, instanceId, heartbeatTimer }
  console.log(`[AgentFabric] 节点 ${selfNode.agentId}（${instanceId}）已启动，监听 http://${server.address}`)
  return server.address
}

export async function stopAgentFabricService(): Promise<void> {
  if (!state) return
  clearInterval(state.heartbeatTimer)
  try {
    await state.server.close()
  } catch (error) {
    console.error('[AgentFabric] 关闭 HTTP 服务失败:', error)
  }
  state = null
}
