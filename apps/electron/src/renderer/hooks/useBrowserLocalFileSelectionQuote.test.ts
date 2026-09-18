import { describe, expect, test } from 'bun:test'

import type { QuotedSelection } from '@/atoms/preview-atoms'

import { reduceBrowserFileSelection } from './useBrowserLocalFileSelectionQuote'

const event = (over: Partial<Parameters<typeof reduceBrowserFileSelection>[1]> = {}) => ({
  sessionId: 'session-1',
  text: '被引用的那段话',
  filePath: '/tmp/samples/sample-legacy.doc',
  fileName: 'sample-legacy.doc',
  ...over,
})

const quoted = (over: Partial<QuotedSelection> = {}): QuotedSelection => ({
  text: '旧引用',
  filePath: '/tmp/samples/sample.zip',
  sourceType: 'file',
  sourceLabel: 'sample.zip',
  capturedAt: 1,
  ...over,
})

describe('浏览器列划词 → 引用', () => {
  test('写入引用：字段与预览面板同口径（sourceType=file + 文件名作展示名）', () => {
    const next = reduceBrowserFileSelection(new Map(), event())
    expect(next.get('session-1')).toMatchObject({
      text: '被引用的那段话',
      filePath: '/tmp/samples/sample-legacy.doc',
      sourceType: 'file',
      sourceLabel: 'sample-legacy.doc',
    })
  })

  test('同一会话重复选同一段：返回原 Map，避免无谓重渲染', () => {
    const previous = new Map([['session-1', quoted({ text: '被引用的那段话', filePath: '/tmp/samples/sample-legacy.doc' })]])
    expect(reduceBrowserFileSelection(previous, event())).toBe(previous)
  })

  test('空串表示选区被清空：撤掉引用', () => {
    const previous = new Map([['session-1', quoted()], ['session-2', quoted()]])
    const next = reduceBrowserFileSelection(previous, event({ text: '' }))
    expect(next.has('session-1')).toBe(false)
    expect(next.get('session-2')).toBeDefined()
  })

  test('本就没有引用时收到空串：原 Map 不动', () => {
    const previous = new Map<string, QuotedSelection>()
    expect(reduceBrowserFileSelection(previous, event({ text: '' }))).toBe(previous)
  })

  test('同名文件不同路径 / 同文本不同文件都算新引用', () => {
    const previous = new Map([['session-1', quoted({ text: 'x', filePath: '/a/demo.doc' })]])
    const next = reduceBrowserFileSelection(previous, event({ text: 'x', filePath: '/b/demo.doc', fileName: 'demo.doc' }))
    expect(next.get('session-1')?.filePath).toBe('/b/demo.doc')
  })

  test('不污染其它会话的引用', () => {
    const previous = new Map([['session-9', quoted()]])
    const next = reduceBrowserFileSelection(previous, event())
    expect(next.get('session-9')).toEqual(previous.get('session-9'))
    expect(next.size).toBe(2)
  })
})
