/**
 * Agent Fabric 本地服务配置
 *
 * 设计文档 §4：第一阶段只监听 127.0.0.1；绑定 LAN/Tailscale 必须显式配置。
 * 启用方式（显式 opt-in）：
 * - 环境变量 PROFER_AGENT_FABRIC=1
 * - 或配置目录下 agent-fabric.json 的 enabled=true
 *
 * 端口默认：正式版 4788、开发版 4789（与 remote-service 7788/7789 隔离，dev/stable 可并存）。
 * 本文件不 import electron，供 bun test 直接运行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir, getConfigDirName } from '../config-paths'
import { WELL_KNOWN_AGENT_IDS } from '@profer/agent-fabric'

export interface AgentFabricConfig {
  enabled: boolean
  host: string
  port: number
  /** 本节点逻辑身份：正式版 profer-stable，开发版 profer-dev。 */
  agentId: string
  /** headless 执行器默认参数（可在提交任务时被任务字段覆盖的部分见 executor）。 */
  defaultChannelId?: string
  defaultModelId?: string
  defaultWorkspaceId?: string
}

interface FabricConfigFile {
  enabled?: boolean
  port?: number
  defaultChannelId?: string
  defaultModelId?: string
  defaultWorkspaceId?: string
}

export function getFabricConfigFilePath(): string {
  return join(getConfigDir(), 'agent-fabric.json')
}

export function isDevProfile(): boolean {
  return getConfigDirName() === '.profer-dev'
}

export function getDefaultFabricPort(): number {
  return isDevProfile() ? 4789 : 4788
}

/** 当前进程的 Fabric 节点逻辑身份。 */
export function getLocalFabricAgentId(): string {
  return isDevProfile() ? WELL_KNOWN_AGENT_IDS.DEV : WELL_KNOWN_AGENT_IDS.STABLE
}

function readConfigFile(): FabricConfigFile {
  const path = getFabricConfigFilePath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as FabricConfigFile
  } catch (error) {
    console.error('[AgentFabric] 配置文件解析失败，按空配置处理:', error)
    return {}
  }
}

export function loadAgentFabricConfig(): AgentFabricConfig {
  const file = readConfigFile()
  const enabled = process.env.PROFER_AGENT_FABRIC === '1' || file.enabled === true
  const port = (() => {
    const envPort = Number(process.env.PROFER_AGENT_FABRIC_PORT)
    if (Number.isInteger(envPort) && envPort > 0) return envPort
    if (Number.isInteger(file.port) && (file.port as number) > 0) return file.port as number
    return getDefaultFabricPort()
  })()

  return {
    enabled,
    // 安全默认值：只允许 loopback。PROFER_AGENT_FABRIC_HOST 属于显式风险操作，不在此处支持。
    host: '127.0.0.1',
    port,
    agentId: getLocalFabricAgentId(),
    defaultChannelId: file.defaultChannelId,
    defaultModelId: file.defaultModelId,
    defaultWorkspaceId: file.defaultWorkspaceId,
  }
}
