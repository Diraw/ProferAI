import { describe, expect, mock, test } from 'bun:test'
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'
import { createEffectiveAgentPresetPolicy } from '@profer/shared'

const externalNames = ['mcp__reports__fetch_report']
mock.module('./adapters/pi-mcp-tools', () => ({
  discoverExternalMcpTools: async () => externalNames.map(name => {
    const [, serverName, toolName] = name.split('__')
    return { serverName, tool: { name: toolName } }
  }),
}))
const { captureSkillToolInventory } = await import('./skill-tool-inventory')
const policy = createEffectiveAgentPresetPolicy({ id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, disabledTools: ['mcp__reports__fetch_report'] }, { presetId: 'test', presetScope: 'workspace', workspaceSlug: 'test' }, { runtimeSupportsSubagents: true })

describe('Skill 实际工具清单', () => {
  test('内置工具观察和外部 MCP listTools 合并，禁用全名不重新进入清单', async () => {
    const fakeSdk = { createSdkMcpServer: (options: { name: string }) => ({ type: 'sdk', name: options.name }) } as unknown as typeof ClaudeSdk
    const inventory = captureSkillToolInventory(fakeSdk)
    inventory.sdk.createSdkMcpServer({ name: 'automation', tools: [{ name: 'list_automations' } as ClaudeSdk.SdkMcpToolDefinition] })
    const tools = await inventory.getToolNames({ automation: { type: 'sdk' }, reports: { type: 'stdio' } }, policy)
    expect(tools).toContain('mcp__automation__list_automations')
    expect(tools).not.toContain('mcp__reports__fetch_report')
    externalNames.push('mcp__reports__read_report', 'mcp__reports-prod__fetch_report')
    expect(await inventory.getToolNames({ reports: { type: 'stdio' } }, policy)).toContain('mcp__reports__read_report')
    const denied = createEffectiveAgentPresetPolicy({ id: 'test', name: 'test', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, disabledTools: ['mcp__reports-prod__fetch_report'] }, policy.presetReference, { runtimeSupportsSubagents: true })
    const rawNames = await inventory.getToolNames({ 'reports-prod': { type: 'stdio' } }, denied)
    expect(rawNames).not.toContain('mcp__reports-prod__fetch_report')
    expect(rawNames).not.toContain('mcp__reports_prod__fetch_report')
  })
})
