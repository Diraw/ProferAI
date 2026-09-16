import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@profer/shared'
import type { AssistantTurnRenderItem } from './ProcessBlockGroup'
import { applyRenderWindow, DEFAULT_RENDER_WINDOW } from './render-window'

function block(text: string): SDKContentBlock {
  return { type: 'text', text } as unknown as SDKContentBlock
}

/** 构造一轮：前段是过程组（含 processCount 个段），后段是回复（replyCount 段） */
function makeItems(processCount: number, replyCount: number): AssistantTurnRenderItem[] {
  const items: AssistantTurnRenderItem[] = []
  if (processCount > 0) {
    items.push({
      type: 'process-group',
      items: Array.from({ length: processCount }, (_, i) => ({ block: block(`过程${i}`), index: i })),
    })
  }
  for (let i = 0; i < replyCount; i++) {
    items.push({ type: 'block', item: { block: block(`回复${i}`), index: processCount + i } })
  }
  return items
}

const visibleSegmentTexts = (items: AssistantTurnRenderItem[]): string[] => {
  const texts: string[] = []
  for (const item of items) {
    if (item.type === 'block') texts.push((item.item.block as { text: string }).text)
    else for (const groupItem of item.items) texts.push((groupItem.block as { text: string }).text)
  }
  return texts
}

describe('渲染窗口 · 基本裁剪', () => {
  test('Given 都未超窗 When 裁剪 Then 不折叠且结构不变', () => {
    const { items, foldedProcessCount, foldedReplyCount } = applyRenderWindow(makeItems(5, 3))

    expect(foldedProcessCount).toBe(0)
    expect(foldedReplyCount).toBe(0)
    expect(visibleSegmentTexts(items)).toEqual(['过程0', '过程1', '过程2', '过程3', '过程4', '回复0', '回复1', '回复2'])
  })

  test('Given 过程超窗 When 裁剪 Then 只保留最近 N 段且折叠计数正确', () => {
    const { items, foldedProcessCount, foldedReplyCount } = applyRenderWindow(makeItems(50, 2))

    expect(foldedProcessCount).toBe(50 - DEFAULT_RENDER_WINDOW.processSegments)
    expect(foldedReplyCount).toBe(0)
    const texts = visibleSegmentTexts(items)
    // 过程只保留末尾 20 段（过程30..过程49），回复不受影响
    expect(texts.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `过程${30 + i}`))
    expect(texts.slice(-2)).toEqual(['回复0', '回复1'])
  })

  test('Given 回复超窗 When 裁剪 Then 只保留最近 N 段', () => {
    const { items, foldedReplyCount } = applyRenderWindow(makeItems(2, 45))

    expect(foldedReplyCount).toBe(45 - DEFAULT_RENDER_WINDOW.replySegments)
    const texts = visibleSegmentTexts(items)
    expect(texts.slice(-1)).toEqual(['回复44'])
    expect(texts.filter((t) => t.startsWith('回复'))).toHaveLength(DEFAULT_RENDER_WINDOW.replySegments)
  })
})

describe('渲染窗口 · 过程与回复独立计数', () => {
  test('Given 过程很长 When 裁剪 Then 回复段数不受过程影响', () => {
    // 这是「分开算窗口」的核心价值：过程再长也不该把回复挤掉
    const replyCount = 10
    const { foldedReplyCount, items } = applyRenderWindow(makeItems(300, replyCount))

    expect(foldedReplyCount).toBe(0)
    expect(visibleSegmentTexts(items).filter((t) => t.startsWith('回复'))).toHaveLength(replyCount)
  })

  test('Given 回复很长 When 裁剪 Then 过程段数不受回复影响', () => {
    const { foldedProcessCount } = applyRenderWindow(makeItems(8, 200))

    expect(foldedProcessCount).toBe(0)
  })
})

describe('渲染窗口 · 展开', () => {
  test('Given 过程已折叠 When 展开 10 段 Then 可见段数增加且折叠数减少', () => {
    const base = applyRenderWindow(makeItems(50, 2))
    const expanded = applyRenderWindow(makeItems(50, 2), { expandedProcess: 10 })

    expect(expanded.foldedProcessCount).toBe(base.foldedProcessCount - 10)
    expect(visibleSegmentTexts(expanded.items).filter((t) => t.startsWith('过程'))).toHaveLength(
      visibleSegmentTexts(base.items).filter((t) => t.startsWith('过程')).length + 10,
    )
  })

  test('Given 展开超过总量 When 裁剪 Then 全量展示且折叠为 0', () => {
    const { items, foldedProcessCount, foldedReplyCount } = applyRenderWindow(makeItems(30, 40), {
      expandedProcess: 999,
      expandedReply: 999,
    })

    expect(foldedProcessCount).toBe(0)
    expect(foldedReplyCount).toBe(0)
    expect(visibleSegmentTexts(items)).toHaveLength(70)
  })

  test('Given 过程与回复同时展开 When 裁剪 Then 两个窗口互不干扰', () => {
    const { foldedProcessCount, foldedReplyCount } = applyRenderWindow(makeItems(100, 100), {
      expandedProcess: 5,
      expandedReply: 7,
    })

    expect(foldedProcessCount).toBe(100 - (DEFAULT_RENDER_WINDOW.processSegments + 5))
    expect(foldedReplyCount).toBe(100 - (DEFAULT_RENDER_WINDOW.replySegments + 7))
  })
})

describe('渲染窗口 · 边界与纯函数性质', () => {
  test('Given 空输入 Then 返回空且计数为 0', () => {
    const result = applyRenderWindow([])
    expect(result.items).toEqual([])
    expect(result.foldedProcessCount).toBe(0)
    expect(result.foldedReplyCount).toBe(0)
  })

  test('Given 只有回复没有过程 Then 正常裁剪', () => {
    const { items, foldedProcessCount } = applyRenderWindow(makeItems(0, 40))
    expect(foldedProcessCount).toBe(0)
    expect(visibleSegmentTexts(items)).toHaveLength(DEFAULT_RENDER_WINDOW.replySegments)
  })

  test('Given 自定义窗口上限 Then 按自定义值裁剪', () => {
    const { foldedProcessCount, foldedReplyCount } = applyRenderWindow(makeItems(10, 10), {
      limits: { processSegments: 4, replySegments: 3 },
    })
    expect(foldedProcessCount).toBe(6)
    expect(foldedReplyCount).toBe(7)
  })

  test('Given 调用裁剪 When 检查入参 Then 原始数组未被修改', () => {
    const original = makeItems(50, 40)
    const processBefore = (original[0] as { items: unknown[] }).items.length
    applyRenderWindow(original)
    expect((original[0] as { items: unknown[] }).items.length).toBe(processBefore)
    expect(original).toHaveLength(41) // 1 个过程组 + 40 段回复
  })

  test('Given 裁剪后 When 检查顺序 Then 仍是「过程组在前、回复在后」', () => {
    const { items } = applyRenderWindow(makeItems(50, 40))
    const firstBlockIndex = items.findIndex((item) => item.type === 'block')
    const lastProcessIndex = items.map((item) => item.type).lastIndexOf('process-group')
    expect(lastProcessIndex).toBeLessThan(firstBlockIndex)
  })
})
