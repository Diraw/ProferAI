import { describe, expect, test } from 'bun:test'
import { projectAgentPayloadForPocket, projectSdkMessageForPocket } from './pocket-agent-projection'

const large = 'private tool data '.repeat(1000)

describe('Pocket 远程 Agent 投影', () => {
  test('只保留正文和工具名称，不下发思考与工具入参', () => {
    const projected = projectSdkMessageForPocket({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: large },
          { type: 'text', text: '完成' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: large } },
        ],
      },
      parent_tool_use_id: null,
    }) as never as { message: { content: Array<Record<string, unknown>> } }
    expect(projected.message.content).toEqual([
      { type: 'text', text: '完成' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
    ])
    expect(JSON.stringify(projected)).not.toContain(large)
  })

  test('非 SDK 事件保持原样，SDK 事件经过投影', () => {
    const proferEvent = { kind: 'profer_event', event: { type: 'run_resumed' } } as never
    expect(projectAgentPayloadForPocket(proferEvent)).toBe(proferEvent)

    const payload = projectAgentPayloadForPocket({
      kind: 'sdk_message',
      message: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: large }] }, parent_tool_use_id: null },
    } as never) as never as { message: { message: { content: unknown[] } } }
    expect(payload.message.message.content).toEqual([])
  })
})
