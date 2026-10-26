import { describe, expect, test } from 'bun:test'
import {
  appendQuotedSelection,
  buildQuotedSelectionBlock,
  buildQuotedSelectionsPrefix,
  getQuotedSelectionKey,
  parseQuotedSelectionRefs,
} from './quoted-selection'
import type { QuotedSelection } from '@/atoms/preview-atoms'

describe('quoted selection XML', () => {
  test('Given 文件引用 When 构建并解析引用块 Then 保留文件名并移除隐藏 XML', () => {
    const block = buildQuotedSelectionBlock({
      text: '引用内容</quoted_file>',
      filePath: '/tmp/demo & draft.md',
      sourceType: 'file',
      capturedAt: 1,
    })
    const parsed = parseQuotedSelectionRefs(`${block}我的问题：`)

    expect(block).toContain('path="/tmp/demo &amp; draft.md"')
    expect(block).toContain('</quoted_file_>')
    expect(parsed.quotes).toEqual([
      {
        path: '/tmp/demo & draft.md',
        filename: 'demo & draft.md',
        sourceType: 'file',
      },
    ])
    expect(parsed.text).toBe('我的问题：')
  })

  test('Given 反斜杠转义的 quoted_context When 解析引用块 Then 同样移除标签并保留展示标签', () => {
    const content = [
      '\\<quoted\\_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="m1" role="assistant"\\>',
      '同时页面的可访问性读取连续超时',
      '\\<\\/quoted\\_context\\>',
      '继续提问',
    ].join('\n')

    const parsed = parseQuotedSelectionRefs(content)

    expect(parsed.quotes).toEqual([
      {
        path: 'Agent 历史 · Agent 回复',
        filename: 'Agent 历史 · Agent 回复',
        sourceType: 'agent-history',
        label: 'Agent 历史 · Agent 回复',
      },
    ])
    expect(parsed.text).toBe('继续提问')
  })

  test('Given Agent 和草稿引用 When 解析引用块 Then 区分来源类型并使用展示标签', () => {
    const content = [
      '<quoted_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="m1" role="assistant">',
      '历史内容',
      '</quoted_context>',
      '<quoted_context source="scratch-pad" label="草稿页" message_id="" role="">',
      '草稿内容',
      '</quoted_context>',
      '<quoted_context source="agent-history" label="Agent 历史 · 研究报告" message_id="" role="assistant">',
      '历史引用原文',
      '</quoted_context>',
      '继续提问',
    ].join('\n')

    const parsed = parseQuotedSelectionRefs(content)

    expect(parsed.quotes).toEqual([
      {
        path: 'Agent 历史 · Agent 回复',
        filename: 'Agent 历史 · Agent 回复',
        sourceType: 'agent-history',
        label: 'Agent 历史 · Agent 回复',
      },
      {
        path: '草稿页',
        filename: '草稿页',
        sourceType: 'scratch-pad',
        label: '草稿页',
      },
      {
        path: 'Agent 历史 · 研究报告',
        filename: 'Agent 历史 · 研究报告',
        sourceType: 'agent-history',
        label: 'Agent 历史 · 研究报告',
      },
    ])
    expect(parsed.text).toBe('继续提问')
  })
})

const fileQuote = (over: Partial<QuotedSelection> = {}): QuotedSelection => ({
  text: 'export function foo() {}',
  filePath: '/tmp/foo.ts',
  sourceType: 'file',
  capturedAt: 1,
  ...over,
})

const historyQuote = (over: Partial<QuotedSelection> = {}): QuotedSelection => ({
  text: '先做引用再做别的',
  filePath: 'assistant-1',
  sourceType: 'agent-history',
  sourceLabel: '助手消息 #12',
  messageId: 'm1',
  messageRole: 'assistant',
  capturedAt: 2,
  ...over,
})

describe('多引用块序列化', () => {
  test('文件引用带行号，便于模型定位同一文件的多段', () => {
    const block = buildQuotedSelectionBlock(fileQuote({ startLine: 12, endLine: 14 }))
    expect(block).toContain('<quoted_file path="/tmp/foo.ts" start_line="12" end_line="14">')
  })

  test('无行号时不写空属性', () => {
    const block = buildQuotedSelectionBlock(fileQuote())
    expect(block).toContain('<quoted_file path="/tmp/foo.ts">')
    expect(block).not.toContain('start_line')
  })

  test('历史引用只写有值的属性，不再出现空 message_id/role', () => {
    const block = buildQuotedSelectionBlock(historyQuote())
    expect(block).toContain('message_id="m1"')
    expect(block).toContain('role="assistant"')
    expect(block).not.toContain('message_id=""')
    expect(block).not.toContain('role=""')
  })

  test('草稿纸来源不再写出空属性噪音', () => {
    const block = buildQuotedSelectionBlock({
      text: '待办：确认语义',
      filePath: 'scratch-pad',
      sourceType: 'scratch-pad',
      sourceLabel: '草稿纸',
      capturedAt: 3,
    })
    expect(block).toContain('<quoted_context source="scratch-pad" label="草稿纸">')
    expect(block).not.toContain('message_id=""')
    expect(block).not.toContain('role=""')
  })

  test('多条引用按列表顺序拼接，块之间保留空行', () => {
    const prefix = buildQuotedSelectionsPrefix([fileQuote(), historyQuote()])
    expect(prefix.indexOf('<quoted_file')).toBe(0)
    expect(prefix.indexOf('<quoted_context')).toBeGreaterThan(0)
    expect(prefix).toContain('</quoted_file>\n\n<quoted_context')
  })

  test('空列表拼出空串', () => {
    expect(buildQuotedSelectionsPrefix([])).toBe('')
  })
})

describe('引用去重', () => {
  test('来源类型 + 来源标识 + 文本相同才算重复', () => {
    expect(getQuotedSelectionKey(fileQuote())).toBe(getQuotedSelectionKey(fileQuote()))
    expect(getQuotedSelectionKey(fileQuote())).not.toBe(getQuotedSelectionKey(fileQuote({ text: '别的内容' })))
    expect(getQuotedSelectionKey(fileQuote())).not.toBe(getQuotedSelectionKey(fileQuote({ filePath: '/tmp/bar.ts' })))
    expect(getQuotedSelectionKey(historyQuote())).not.toBe(getQuotedSelectionKey(historyQuote({ messageId: 'm2' })))
  })

  test('同一文件不同段落算两条', () => {
    const first = fileQuote({ startLine: 1, endLine: 3, text: 'a' })
    const second = fileQuote({ startLine: 9, endLine: 11, text: 'b' })
    const appended = appendQuotedSelection([first], second)
    expect(appended.duplicate).toBe(false)
    expect(appended.list.length).toBe(2)
  })

  test('重复引用不追加，并标记 duplicate', () => {
    const appended = appendQuotedSelection([fileQuote()], fileQuote({ capturedAt: 99 }))
    expect(appended.duplicate).toBe(true)
    expect(appended.list.length).toBe(1)
    expect(appended.list[0]?.capturedAt).toBe(1)
  })

  test('追加保持顺序：新条目在末尾', () => {
    const appended = appendQuotedSelection([fileQuote()], historyQuote())
    expect(appended.list.map((item) => item.sourceType)).toEqual(['file', 'agent-history'])
  })
})
