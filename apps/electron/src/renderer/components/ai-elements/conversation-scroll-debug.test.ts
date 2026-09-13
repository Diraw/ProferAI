import { describe, expect, test } from 'bun:test'
import { getConversationScrollDebugOptions } from './conversation-scroll-debug'

describe('getConversationScrollDebugOptions', () => {
  test('生产环境始终关闭诊断与锚定实验', () => {
    expect(getConversationScrollDebugOptions('', false)).toEqual({
      enabled: false,
      scrollAnchor: 'auto',
    })
    expect(getConversationScrollDebugOptions('?conversationScrollDebug=1', false)).toEqual({
      enabled: false,
      scrollAnchor: 'auto',
    })
    expect(getConversationScrollDebugOptions('?conversationScrollAnchor=none', false)).toEqual({
      enabled: false,
      scrollAnchor: 'auto',
    })
  })

  test('开发环境默认关闭观测：观测本身在拖拽时会制造卡顿', () => {
    expect(getConversationScrollDebugOptions('', true)).toEqual({
      enabled: false,
      scrollAnchor: 'auto',
    })
  })

  test('开发环境需要显式开启：URL 参数或启动期环境变量', () => {
    expect(getConversationScrollDebugOptions('?conversationScrollDebug=1', true).enabled).toBe(true)
    expect(getConversationScrollDebugOptions('', true, true).enabled).toBe(true)
    expect(getConversationScrollDebugOptions('?conversationScrollDebug=0', true, false).enabled).toBe(false)
  })

  test('锚定实验组需显式指定 none', () => {
    expect(getConversationScrollDebugOptions('?conversationScrollAnchor=none', true).scrollAnchor).toBe('none')
    expect(getConversationScrollDebugOptions('', true).scrollAnchor).toBe('auto')
  })
})
