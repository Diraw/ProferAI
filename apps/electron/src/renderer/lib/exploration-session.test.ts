import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { buildExplorationReferenceDraft, getLatestExplorationConclusion } from './exploration-session'
import { parseQueuedMessageMentions } from './agent-message-queue'

function message(uuid: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as SDKMessage
}

describe('探索分支引用', () => {
  test('Given fork 前历史与 fork 后回复 When 提取结论 Then 只返回锚点后的最新 assistant 文本', () => {
    const messages = [message('source', '主线旧结论'), message('new-1', '探索第一轮'), message('new-2', '探索最终结论')]
    expect(getLatestExplorationConclusion(messages, 'source')).toBe('探索最终结论')
  })

  test('Given 锚点不存在或没有新增回复 When 提取结论 Then 返回空字符串', () => {
    expect(getLatestExplorationConclusion([message('other', '内容')], 'missing')).toBe('')
    expect(getLatestExplorationConclusion([message('source', '旧内容')], 'source')).toBe('')
  })

  test('Given fork 后只有内部 sidechain 回复 When 提取结论 Then 不把子 Agent 内容作为主线结论', () => {
    const sidechain = { ...message('sidechain', '内部工具结果'), parent_tool_use_id: 'tool-1' } as SDKMessage
    expect(getLatestExplorationConclusion([message('source', '旧内容'), sidechain], 'source')).toBe('')
  })

  test('Given 分支 ID 和标题 When 构造带回引用 Then markdown/html 都只包含受控 mention', () => {
    const result = buildExplorationReferenceDraft('branch-1', '探索方案')
    expect(result.markdown).toContain('&session:branch-1::')
    expect(result.markdown).not.toContain('探索最终结论')
    expect(result.html).toContain('data-type="mention"')
    expect(result.html).toContain('data-id="branch-1"')
  })

  test('Given 带回生成的 session mention When 解析发送文本 Then 保留分支 ID 并移除展示标签', () => {
    const result = buildExplorationReferenceDraft('branch-1', '探索方案')
    const parsed = parseQueuedMessageMentions(`请吸收\n${result.markdown}`)
    expect(parsed.mentionedSessionIds).toEqual(['branch-1'])
    expect(parsed.cleanedText).toBe('请吸收\n这是探索后的新增内容：')
  })
})
