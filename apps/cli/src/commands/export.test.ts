import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage } from '@profer/shared'
import type { MessageGroup } from '@profer/session-core'
import { findAssistantAnchorTurnIndex } from './export'

function assistant(uuid: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text: uuid }] },
    parent_tool_use_id: null,
  }
}

describe('session export 探索增量锚点', () => {
  test('Given assistant 消息位于某个逻辑 turn When 查找锚点 Then 返回 turn 下标', () => {
    const groups: MessageGroup[] = [
      { type: 'user', message: { type: 'user', message: { content: [{ type: 'text', text: '问题' }] }, parent_tool_use_id: null } },
      { type: 'assistant-turn', assistantMessages: [assistant('assistant-1')], turnMessages: [assistant('assistant-1')] },
      { type: 'assistant-turn', assistantMessages: [assistant('assistant-2'), assistant('assistant-2')], turnMessages: [assistant('assistant-2')] },
    ]

    expect(findAssistantAnchorTurnIndex(groups, 'assistant-1')).toBe(1)
    expect(findAssistantAnchorTurnIndex(groups, 'assistant-2')).toBe(2)
  })

  test('Given 不存在的 assistant UUID When 查找锚点 Then 返回 undefined', () => {
    expect(findAssistantAnchorTurnIndex([], 'missing')).toBeUndefined()
  })
})
