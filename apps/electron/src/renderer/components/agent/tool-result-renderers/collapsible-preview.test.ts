import { describe, expect, test } from 'bun:test'
import { canRevealByStep, sliceResultPreview, sliceResultWindow } from './collapsible-preview'

/** 与 CollapsibleResult 默认值一致 */
const OPTIONS = { maxChars: 3000, previewLines: 15 }

describe('工具结果折叠预览', () => {
  test('Given 短内容 When 计算预览 Then 不折叠并返回原文', () => {
    const content = 'line 1\nline 2'
    const preview = sliceResultPreview(content, OPTIONS)
    expect(preview.collapsed).toBe(false)
    expect(preview.text).toBe(content)
  })

  test('Given 超长单行（无换行）When 计算预览 Then 折叠且预览不超过字符上界', () => {
    const content = 'x'.repeat(5000)
    const preview = sliceResultPreview(content, OPTIONS)
    expect(preview.collapsed).toBe(true)
    expect(preview.text).toHaveLength(OPTIONS.maxChars)
  })

  test('Given 字符未超限但行数超限 When 计算预览 Then 折叠并只保留前若干行', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const preview = sliceResultPreview(content, OPTIONS)
    expect(preview.collapsed).toBe(true)
    expect(preview.text.split('\n')).toHaveLength(OPTIONS.previewLines)
    expect(preview.text.startsWith('line 0\n')).toBe(true)
    expect(preview.text).not.toContain('line 15')
  })

  test('Given 行数与字符数同时超限 When 计算预览 Then 先截行再按字符封顶', () => {
    const content = Array.from({ length: 20 }, () => 'y'.repeat(600)).join('\n')
    const preview = sliceResultPreview(content, OPTIONS)
    expect(preview.collapsed).toBe(true)
    expect(preview.text).toHaveLength(OPTIONS.maxChars)
  })

  test('Given 恰好等于两个上界 When 计算预览 Then 不折叠', () => {
    const exactLines = Array.from({ length: OPTIONS.previewLines }, () => 'a').join('\n')
    expect(sliceResultPreview(exactLines, OPTIONS).collapsed).toBe(false)
    expect(sliceResultPreview('z'.repeat(OPTIONS.maxChars), OPTIONS).collapsed).toBe(false)
  })

  test('Given CRLF 内容 When 计算预览 Then 行数不翻倍且预览不残留回车符', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\r\n')
    const preview = sliceResultPreview(content, OPTIONS)
    expect(preview.collapsed).toBe(true)
    expect(preview.text).not.toContain('\r')
    expect(preview.text.split('\n')).toHaveLength(OPTIONS.previewLines)
  })

  test('Given 字符封顶落在代理对中间 When 计算预览 Then 不产生孤立代理', () => {
    const content = '😀😀😀😀'
    const preview = sliceResultPreview(content, { maxChars: 5, previewLines: 15 })
    expect(preview.collapsed).toBe(true)
    expect(preview.text).toBe('😀😀')
    // 反例：直接按字符切片会切出孤立的高位代理
    expect(content.slice(0, 5).charCodeAt(4)).toBe(0xd83d)
  })

  test('Given 非正字符上界 When 计算预览 Then 返回空预览而不是负向切片', () => {
    const preview = sliceResultPreview('abcdef', { maxChars: -1, previewLines: 15 })
    expect(preview.collapsed).toBe(true)
    expect(preview.text).toBe('')
  })
})

/** 与 CollapsibleResult 默认值一致；revealedLines 等于 previewLines 即初始折叠态 */
const WINDOW = { maxChars: 3000, previewLines: 15, revealedLines: 15 }

function makeLines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n')
}

describe('工具结果展开窗口', () => {
  test('Given 初始折叠态 When 计算窗口 Then 与 sliceResultPreview 完全一致', () => {
    const content = makeLines(800)
    const window = sliceResultWindow(content, WINDOW)
    const preview = sliceResultPreview(content, { maxChars: WINDOW.maxChars, previewLines: WINDOW.previewLines })

    expect(window.text).toBe(preview.text)
    expect(window.collapsed).toBe(preview.collapsed)
    expect(window.truncated).toBe(true)
    expect(window.hasMoreLines).toBe(true)
    expect(window.totalLines).toBe(800)
  })

  test('Given 已推进若干行 When 计算窗口 Then 按行数渲染且仍标记为片段', () => {
    const window = sliceResultWindow(makeLines(800), { ...WINDOW, revealedLines: 65 })

    expect(window.text.split('\n')).toHaveLength(65)
    expect(window.text.startsWith('line 0\n')).toBe(true)
    expect(window.text).not.toContain('line 65')
    expect(window.truncated).toBe(true)
    expect(window.hasMoreLines).toBe(true)
  })

  test('Given 一次性全部展开 When 计算窗口 Then 渲染全文且不再是片段', () => {
    const content = makeLines(800)
    const window = sliceResultWindow(content, { ...WINDOW, revealedLines: Number.POSITIVE_INFINITY })

    expect(window.text).toBe(content)
    expect(window.truncated).toBe(false)
    expect(window.hasMoreLines).toBe(false)
  })

  test('Given 单行超长内容 When 一次性全部展开 Then 不再受字符上界截断', () => {
    const content = 'x'.repeat(637_891)

    // 折叠态仍按字符封顶
    const collapsedWindow = sliceResultWindow(content, WINDOW)
    expect(collapsedWindow.text).toHaveLength(WINDOW.maxChars)
    expect(collapsedWindow.truncated).toBe(true)

    // 展开后必须拿到全文：字符封顶只服务于初始预览
    const expandedWindow = sliceResultWindow(content, { ...WINDOW, revealedLines: Number.POSITIVE_INFINITY })
    expect(expandedWindow.text).toHaveLength(637_891)
    expect(expandedWindow.truncated).toBe(false)
  })

  test('Given 只有一行 When 初始折叠态 Then 不提供按行递进', () => {
    const window = sliceResultWindow('x'.repeat(637_891), WINDOW)

    expect(window.totalLines).toBe(1)
    expect(window.hasMoreLines).toBe(false)
  })

  test('Given 行数不足预览行数但字符超限 When 初始折叠态 Then 只有字符封顶、无行可递进', () => {
    const content = Array.from({ length: 10 }, () => 'y'.repeat(600)).join('\n')
    const window = sliceResultWindow(content, WINDOW)

    expect(window.collapsed).toBe(true)
    expect(window.hasMoreLines).toBe(false)
    expect(window.truncated).toBe(true)
  })

  test('Given 递进步长超过剩余行数 When 计算窗口 Then 收敛到总行数', () => {
    const content = makeLines(20)
    const window = sliceResultWindow(content, { ...WINDOW, revealedLines: 65 })

    expect(window.totalLines).toBe(20)
    expect(window.text).toBe(content)
    expect(window.hasMoreLines).toBe(false)
    expect(window.truncated).toBe(false)
  })

  test('Given CRLF 内容 When 全部展开 Then 判定为完整而非片段', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n')
    const window = sliceResultWindow(content, { ...WINDOW, revealedLines: Number.POSITIVE_INFINITY })

    // 归一化会去掉 \r，因此不能用字符长度判断是否还有未显示内容
    expect(window.text.length).toBeLessThan(content.length)
    expect(window.truncated).toBe(false)
    expect(window.text).not.toContain('\r')
  })

  test('Given 内容未超任一上界 When 计算窗口 Then 不折叠且无控件', () => {
    const content = 'a\nb\nc'
    const window = sliceResultWindow(content, WINDOW)

    expect(window.collapsed).toBe(false)
    expect(window.text).toBe(content)
    expect(window.truncated).toBe(false)
    expect(window.hasMoreLines).toBe(false)
  })
})

describe('递进按钮的可见性', () => {
  test('Given 剩余行数多于一个步长 When 判断是否提供递进 Then 提供', () => {
    const window = sliceResultWindow(makeLines(801), WINDOW)

    expect(window.visibleLines).toBe(15)
    expect(canRevealByStep(window, 50)).toBe(true)
  })

  test('Given 剩余行数不足一个步长 When 判断是否提供递进 Then 只保留全部展开', () => {
    const window = sliceResultWindow(makeLines(801), { ...WINDOW, revealedLines: 765 })

    expect(window.totalLines - window.visibleLines).toBe(36)
    expect(canRevealByStep(window, 50)).toBe(false)
  })

  test('Given 剩余行数恰好等于步长 When 判断是否提供递进 Then 同样合并为全部展开', () => {
    const window = sliceResultWindow(makeLines(801), { ...WINDOW, revealedLines: 751 })

    // 点一次「再显示 50 行」正好到达全量，与「全部展开」结果相同
    expect(window.totalLines - window.visibleLines).toBe(50)
    expect(canRevealByStep(window, 50)).toBe(false)
  })

  test('Given 未启用渐进展开 When 判断是否提供递进 Then 始终不提供', () => {
    const window = sliceResultWindow(makeLines(801), WINDOW)

    expect(canRevealByStep(window, 0)).toBe(false)
    expect(canRevealByStep(window, -1)).toBe(false)
  })

  test('Given 单行超长内容 When 判断是否提供递进 Then 无行可推故不提供', () => {
    const window = sliceResultWindow('x'.repeat(637_891), WINDOW)

    expect(window.visibleLines).toBe(1)
    expect(canRevealByStep(window, 50)).toBe(false)
  })
})
