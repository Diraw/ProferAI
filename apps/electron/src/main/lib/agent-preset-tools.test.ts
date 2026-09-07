import { describe, expect, test } from 'bun:test'
import { injectAgentPresetMcpServer } from './agent-preset-tools'

interface CapturedTool {
  name: string
  execute?: (args: Record<string, unknown>) => Promise<unknown>
}

function createSdkStub(): typeof import('@anthropic-ai/claude-agent-sdk') {
  return {
    tool(name: string, _description: string, _schema: unknown, execute: CapturedTool['execute']) {
      return { name, execute }
    },
    createSdkMcpServer(input: { name: string; version: string; tools: CapturedTool[] }) {
      return input
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
}

async function registeredTools(
  context: Parameters<typeof injectAgentPresetMcpServer>[2],
): Promise<CapturedTool[]> {
  const servers: Record<string, Record<string, unknown>> = {}
  await injectAgentPresetMcpServer(createSdkStub(), servers, context)
  return (servers['agent-presets'] as unknown as { tools: CapturedTool[] }).tools
}

describe('Agent preset MCP intent gate', () => {
  test('Given no explicit preset mutation intent Then only preset_list is registered', async () => {
    const tools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: [],
    })
    expect(tools.map((tool) => tool.name)).toEqual(['preset_list'])
  })

  test('Given explicit create or copy intent Then only that low-risk operation is registered', async () => {
    const createTools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['create'],
    })
    expect(createTools.map((tool) => tool.name)).toEqual(['preset_list', 'preset_create'])

    const copyTools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['copy'],
    })
    expect(copyTools.map((tool) => tool.name)).toEqual(['preset_list', 'preset_copy'])
  })

  test('Given explicit switch intent and a frozen reference Then only the switch tool is registered', async () => {
    const tools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['switch'],
      currentPresetReference: { presetId: 'minimal', presetScope: 'builtin-meta' },
      userMessage: '切换到标准预设',
    })
    expect(tools.map((tool) => tool.name)).toEqual(['preset_list', 'preset_switch_session'])

    const missingSnapshot = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['switch'],
    })
    expect(missingSnapshot.map((tool) => tool.name)).toEqual(['preset_list'])
  })

  test('Given explicit update or default intent Then only the matching proposal tool is registered', async () => {
    const updateTools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['propose_update'],
      userMessage: '请修改研究预设',
    })
    expect(updateTools.map((tool) => tool.name)).toEqual(['preset_list', 'preset_propose_update'])

    const defaultTools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['propose_default'],
      userMessage: '把研究预设设为默认',
    })
    expect(defaultTools.map((tool) => tool.name)).toEqual(['preset_list', 'preset_request_default_change'])
  })

  test('Given a pending proposal and explicit confirmation Then only the no-argument commit tool is registered', async () => {
    const tools = await registeredTools({
      sessionId: 'pending-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['commit_change'],
      userMessage: '确认',
      pendingChange: {
        proposalId: 'proposal-1',
        kind: 'default',
        sessionId: 'pending-session',
        workspaceSlug: 'demo',
        target: { presetId: 'standard', presetScope: 'builtin-meta' },
        currentDefault: { presetId: 'minimal', presetScope: 'builtin-meta' },
        proposalAuditEventId: 'audit-1',
        createdAt: Date.now(),
      },
    })
    expect(tools.map((tool) => tool.name)).toEqual(['preset_list', 'preset_commit_change'])
    const commit = tools.find((tool) => tool.name === 'preset_commit_change')!
    expect(commit.execute).toBeFunction()
    expect(commit).not.toHaveProperty('parameters.targetId')
  })

  test('Given automation, delegation, or no workspace Then mutation tools stay unavailable', async () => {
    const automationTools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'automation',
      allowedOperations: ['create', 'copy'],
    })
    expect(automationTools.map((tool) => tool.name)).toEqual(['preset_list'])

    const delegationTools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'delegation',
      allowedOperations: ['create', 'copy'],
    })
    expect(delegationTools.map((tool) => tool.name)).toEqual(['preset_list'])

    const noWorkspaceTools = await registeredTools({
      sessionId: 'missing-session',
      source: 'user',
      allowedOperations: ['create', 'copy'],
    })
    expect(noWorkspaceTools.map((tool) => tool.name)).toEqual(['preset_list'])
  })

  test('Given any allowed intent Then high-risk mutation tools are never registered', async () => {
    const tools = await registeredTools({
      sessionId: 'missing-session',
      workspaceSlug: 'demo',
      source: 'user',
      allowedOperations: ['create', 'copy', 'switch'],
      currentPresetReference: { presetId: 'minimal', presetScope: 'builtin-meta' },
      userMessage: '切换到标准预设',
    })
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain('preset_update')
    expect(names).not.toContain('preset_delete')
    expect(names).not.toContain('preset_set_default')
    expect(names).toContain('preset_switch_session')
    expect(names).not.toContain('preset_update')
    expect(names).not.toContain('preset_delete')
    expect(names).not.toContain('preset_set_default')
  })
})
