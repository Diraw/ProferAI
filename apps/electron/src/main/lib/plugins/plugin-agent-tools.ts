import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Type, type TSchema } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { listInstalledPlugins } from './plugin-manager'
import { assertPluginPermission, getGrantedPermissions } from './plugin-permissions'

/** 稳定命名避免不同插件撞名；Claude 和 Pi 使用相同完整工具名。 */
export function pluginToolServerName(pluginId: string): string { return `plugin_${createHash('sha256').update(pluginId).digest('hex').slice(0, 16)}` }
export async function buildPluginAgentTools(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  allowed: (server: string, tool: string) => boolean,
): Promise<ToolDefinition[]> {
  const piTools: ToolDefinition[] = []
  for (const plugin of listInstalledPlugins()) {
    const pluginId = plugin.manifest.id
    if (!plugin.enabled || !getGrantedPermissions(pluginId).includes('agent.tools')) continue
    const serverName = pluginToolServerName(pluginId)
    const sdkTools = []
    for (const tool of plugin.manifest.contributes.tools ?? []) {
      const name = `mcp__${serverName}__${tool.id}`
      if (!allowed(serverName, tool.id)) continue
      const zodProperties: Record<string, z.ZodType> = {}, typeboxProperties: Record<string, TSchema> = {}
      for (const [key, parameter] of Object.entries(tool.parameters)) {
        const schema = parameter.type === 'string' ? z.string().max(100_000) : parameter.type === 'number' ? z.number().finite() : z.boolean()
        const box = parameter.type === 'string' ? Type.String({ maxLength: 100_000 }) : parameter.type === 'number' ? Type.Number() : Type.Boolean()
        zodProperties[key] = (parameter.required ? schema : schema.optional()).describe(parameter.description ?? key)
        typeboxProperties[key] = parameter.required ? box : Type.Optional(box)
      }
      const execute = async (args: unknown, signal?: AbortSignal): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
        try {
          assertPluginPermission(pluginId, 'agent.tools')
          const input = z.object(zodProperties).strict().parse(args)
          const { pluginViewManager } = await import('./plugin-view-manager')
          const result = await pluginViewManager.runTool(pluginId, tool.id, input, signal)
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '插件工具执行失败' }] }
        }
      }
      sdkTools.push(sdk.tool(tool.id, `[${plugin.manifest.name}] ${tool.description}`, zodProperties, (args, extra) => execute(args, typeof extra === 'object' && extra !== null && 'signal' in extra && extra.signal instanceof AbortSignal ? extra.signal : undefined)))
      piTools.push({
        name, label: `${plugin.manifest.name} · ${tool.title}`, description: `[${plugin.manifest.name}] ${tool.description}`,
        parameters: Type.Object(typeboxProperties, { additionalProperties: false }),
        execute: async (_id, args, signal) => {
          const result = await execute(args, signal)
          if (result.isError) throw new Error(result.content[0]?.text ?? '插件工具失败')
          return { content: result.content, details: { pluginId, toolId: tool.id, isError: result.isError ?? false } }
        },
      })
    }
    if (sdkTools.length) mcpServers[serverName] = sdk.createSdkMcpServer({ name: serverName, version: plugin.manifest.version, tools: sdkTools }) as unknown as Record<string, unknown>
  }
  return piTools
}
