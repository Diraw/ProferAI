import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import {
  buildNavigationEntries,
  groupIntoTurns,
  countTurns,
} from './group'

function user(text: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: `u-${text}`,
    _createdAt: 1000,
    ...extra,
  } as unknown as SDKMessage
}

function assistant(text: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], model: 'gpt-x' },
    parent_tool_use_id: null,
    uuid: `a-${text}`,
    _createdAt: 1000,
    ...extra,
  } as unknown as SDKMessage
}

function system(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return { type: 'system', subtype, _createdAt: 1000, ...extra } as unknown as SDKMessage
}

function toolResult(): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('buildNavigationEntries · 断组口径', () => {
  test('Given 中断记录 When 构建导航 Then 独立成行（与渲染层一致）', () => {
    const entries = buildNavigationEntries([
      user('一'),
      system('interruption_record'),
      assistant('答一'),
    ])

    expect(entries.map((e) => e.role)).toEqual(['user', 'status', 'assistant'])
    expect(entries[1]!.preview).toBe('任务中断')
  })

  test('Given 中断记录 When 走默认 groupIntoTurns Then 不独立成行（回溯水位口径不变）', () => {
    // 这是两层口径的分层保护：countTurns / 回溯水位沿用历史断组集合。
    const messages = [user('一'), system('interruption_record'), assistant('答一')]

    expect(groupIntoTurns(messages).map((g) => g.type)).toEqual(['user', 'assistant-turn'])
    expect(countTurns(messages)).toBe(2)
    expect(buildNavigationEntries(messages)).toHaveLength(3)
  })

  test('Given 技能路由提示 When 构建导航 Then 独立成行', () => {
    const entries = buildNavigationEntries([user('一'), system('skill_routing_notice'), assistant('答')])
    expect(entries.map((e) => e.role)).toEqual(['user', 'status', 'assistant'])
  })

  test('Given compacting When 构建导航 Then 丢弃（渲染层同样不渲染）', () => {
    const entries = buildNavigationEntries([user('一'), system('compacting'), assistant('答')])
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant'])
  })
})

describe('buildNavigationEntries · 身份与预览', () => {
  test('Given 有 uuid 的分组 When 构建 Then id 取 uuid、matchKey 稳定', () => {
    const entries = buildNavigationEntries([user('你好'), assistant('在的')])

    expect(entries[0]!.id).toBe('u-你好')
    expect(entries[1]!.id).toBe('a-在的')
    expect(entries[0]!.matchKey).toBe('user::1000')
    expect(entries[1]!.matchKey).toBe('assistant::1000')
  })

  test('Given 无 uuid 的系统消息 When 构建 Then id 为 null 且 matchKey 带 subtype', () => {
    const entries = buildNavigationEntries([system('interruption_record', { uuid: undefined })])
    expect(entries[0]!.id).toBeNull()
    expect(entries[0]!.matchKey).toBe('status:interruption_record:1000')
  })

  test('Given Goal 迭代注入 When 构建 Then 预览是迭代分隔文案', () => {
    const entries = buildNavigationEntries([
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '目标正文' }] },
        parent_tool_use_id: null,
        uuid: 'g1',
        _goalIteration: 3,
        _createdAt: 1000,
      } as unknown as SDKMessage,
    ])
    expect(entries[0]!.preview).toBe('Goal 自动迭代 · 第 3 轮')
  })

  test('Given 用户消息带 quoted_context When 构建 Then 预览只保留用户自己说的话', () => {
    const entries = buildNavigationEntries([
      user('<quoted_context source="agent-interruption" label="已被用户中断" message_id="" role="">\n上次任务被中断\n</quoted_context>\n\n帮我把它的签名搞定，然后打开'),
    ])

    expect(entries[0]!.preview).toBe('帮我把它的签名搞定，然后打开')
  })

  test('Given 工具结果夹在中间 When 构建 Then 不单独成行', () => {
    const entries = buildNavigationEntries([user('一'), toolResult(), assistant('一答'), user('二'), toolResult(), assistant('二答')])
    expect(entries.map((e) => e.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  test('Given 完整会话 When 构建 Then 每条有 id 或无 id 时必有 matchKey', () => {
    const entries = buildNavigationEntries([
      user('一'),
      system('interruption_record'),
      user('二'),
      assistant('答'),
    ])
    for (const entry of entries) {
      expect(entry.id !== null || entry.matchKey.length > 0).toBe(true)
    }
  })
})
