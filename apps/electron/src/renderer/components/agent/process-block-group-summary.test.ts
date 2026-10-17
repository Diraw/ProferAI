import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@profer/shared'
import { buildProcessGroupSummary, buildProcessGroupToolNames } from './ProcessBlockGroup'

const tool = (id: string, name = 'Read'): SDKContentBlock => ({ type: 'tool_use', id, name, input: {} })
const text = (value: string): SDKContentBlock => ({ type: 'text', text: value })
const thinking = (value: string): SDKContentBlock => ({ type: 'thinking', thinking: value })

describe('过程组摘要统计', () => {
  test('过程内容被渲染窗口折叠后，摘要仍统计完整过程块', () => {
    const allProcessBlocks = [
      ...Array.from({ length: 44 }, (_, index) => tool(`earlier-${index}`)),
      ...Array.from({ length: 21 }, (_, index) => tool(`visible-${index}`, index % 2 === 0 ? 'Read' : 'Edit')),
      ...Array.from({ length: 4 }, (_, index) => text(`消息${index}`)),
    ]
    const visibleProcessBlocks = allProcessBlocks.slice(44)

    expect(buildProcessGroupSummary(visibleProcessBlocks)).toBe('执行过程：21 次工具调用，4 条消息')
    expect(buildProcessGroupSummary(allProcessBlocks)).toBe('执行过程：65 次工具调用，4 条消息')
    expect(buildProcessGroupToolNames(allProcessBlocks)).toEqual(['Read', 'Edit'])
  })

  test('完整统计会忽略不展示的 Goal 工具，但保留思考和正文计数', () => {
    const blocks: SDKContentBlock[] = [
      tool('goal-1', 'update_goal'),
      thinking('分析'),
      text('结果'),
    ]

    expect(buildProcessGroupSummary(blocks)).toBe('执行过程：1 段思考，1 条消息')
    expect(buildProcessGroupToolNames(blocks)).toEqual([])
  })
})
