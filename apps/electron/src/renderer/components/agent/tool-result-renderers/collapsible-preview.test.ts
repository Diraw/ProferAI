import { describe, expect, test } from 'bun:test'
import { sliceResultPreview } from './collapsible-preview'

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
