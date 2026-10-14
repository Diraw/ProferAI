/** 观察已注册的 SDK MCP 工具；外部 MCP 复用现有连接管理器的 listTools。 */
import { discoverExternalMcpTools } from './adapters/pi-mcp-tools'
import type { PiMcpServers } from './adapters/pi-mcp-tools'
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'
import { isEffectiveAgentPresetToolDisabled, type EffectiveAgentPresetPolicy } from '@profer/shared'

export function captureSkillToolInventory(sdk: typeof ClaudeSdk) {
  const registered = new Map<string, string[]>()
  return {
    sdk: {
      ...sdk,
      createSdkMcpServer(options: Parameters<typeof ClaudeSdk.createSdkMcpServer>[0]) {
        const server = sdk.createSdkMcpServer(options)
        registered.set(options.name, options.tools?.map(tool => tool.name) ?? [])
        return server
      },
    },
    async getToolNames(mcpServers: Record<string, Record<string, unknown>>, policy: EffectiveAgentPresetPolicy): Promise<string[]> {
      const native = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']
      // 不调用 MCP tool；仅列出已经授权注入的外部服务器，复用 Pi 的连接缓存与超时。
      const externalNames = (await discoverExternalMcpTools(mcpServers as PiMcpServers))
        .map(({ serverName, tool }) => `mcp__${serverName}__${tool.name}`)
      return [...native, ...Object.keys(mcpServers).flatMap(server => (registered.get(server) ?? []).map(tool => `mcp__${server}__${tool}`)), ...externalNames]
        .filter(tool => !isEffectiveAgentPresetToolDisabled(policy, tool) && !policy.disabledTools?.includes(tool))
    },
  }
}
