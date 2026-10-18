import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PiBuiltinToolsResult } from './adapters/pi-builtin-tools'
import { compactPiToolDefinitions } from './pi-tool-definition-compaction'

export interface PreparedPiToolsContext {
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceSlug?: string
  agentCwd?: string
  permissionMode?: string
  triggeredBy?: string
  disabledToolGroups?: readonly string[]
  disabledTools?: readonly string[]
  allowedPresetOperations?: readonly string[]
  currentPresetReference?: unknown
  collaborationAvailable?: boolean
}

export interface PreparedPiToolsInput {
  context?: PreparedPiToolsContext
  builtin: PiBuiltinToolsResult
  mcpTools: readonly ToolDefinition[]
  pluginTools: readonly ToolDefinition[]
}

/** 合并已完成策略过滤的 Pi 工具；不读取 workspace、preset 或 Electron 状态。 */
export function buildPreparedPiTools(input: PreparedPiToolsInput): ToolDefinition[] {
  return [
    ...compactPiToolDefinitions(input.builtin.tools, { allowBuiltinMcpNames: true }),
    ...input.mcpTools,
    ...input.pluginTools,
  ]
}

export function preparedPiToolsCollaborationAvailable(input: PreparedPiToolsInput): boolean | undefined {
  return input.builtin.collaborationAvailable
}
