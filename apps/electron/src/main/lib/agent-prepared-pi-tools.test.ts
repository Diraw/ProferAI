import { describe, expect, test } from 'bun:test'
import { buildPreparedPiTools, preparedPiToolsCollaborationAvailable } from './agent-prepared-pi-tools'

const tool = (name: string) => ({ name, description: 'fixture', parameters: { type: 'object', properties: { value: { description: 'value' } } } }) as never

describe('Prepared Pi tools builder', () => {
  test('merges compacted builtin, MCP and plugin tools without changing order', () => {
    const input = {
      builtin: { tools: [tool('mcp__builtin__one'), tool('Read')], collaborationAvailable: true },
      context: { sessionId: 'prepared-session', channelId: 'channel', workspaceSlug: 'workspace' },
      mcpTools: [tool('mcp__workspace__one')],
      pluginTools: [tool('plugin__one')],
    }
    const result = buildPreparedPiTools(input)
    expect(input.context).toMatchObject({ sessionId: 'prepared-session', workspaceSlug: 'workspace' })
    expect(result.map(item => item.name)).toEqual(['mcp__builtin__one', 'Read', 'mcp__workspace__one', 'plugin__one'])
    expect(preparedPiToolsCollaborationAvailable(input)).toBe(true)
  })
})
