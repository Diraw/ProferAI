import { describe, expect, test } from 'bun:test'
import { getViewportResizeFollowTarget } from './conversation-viewport-resize-follow'

describe('getViewportResizeFollowTarget', () => {
  test('贴底列表在 viewport 变矮后需要补到底部目标位置（取自运行时日志的真实数值）', () => {
    // 2026-09-13 22:11 运行时日志：窗口变矮后 clientHeight 529 -> 361，
    // scrollTop 停在 7848，而底部目标是 8042，实际脱底 194px。
    expect(getViewportResizeFollowTarget({
      scrollHeight: 8404,
      clientHeight: 361,
      scrollTop: 7848,
      isAtBottom: true,
    })).toBe(8042)
  })

  test('用户已离开底部时绝不抢夺其阅读位置', () => {
    expect(getViewportResizeFollowTarget({
      scrollHeight: 8404,
      clientHeight: 361,
      scrollTop: 7848,
      isAtBottom: false,
    })).toBeNull()
  })

  test('已经贴底（含亚像素取整）时不产生冗余滚动', () => {
    expect(getViewportResizeFollowTarget({
      scrollHeight: 8404,
      clientHeight: 361,
      scrollTop: 8042,
      isAtBottom: true,
    })).toBeNull()

    expect(getViewportResizeFollowTarget({
      scrollHeight: 8404,
      clientHeight: 361,
      scrollTop: 8041.7,
      isAtBottom: true,
    })).toBeNull()
  })
})
