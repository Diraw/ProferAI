/**
 * coach-tour-position 单元测试
 *
 * 固化气泡定位的三条核心规则：方位回退、视口钳制、特殊情况降级。
 * 改 UI 布局或常量时这些用例先红，避免引导静默错位。
 */

import { describe, expect, test } from 'bun:test'
import { computeCardPosition, unionRects, type AnchorRect, type CardSize, type ViewportSize } from './coach-tour-position'

const VIEWPORT: ViewportSize = { width: 1440, height: 900 }
const CARD: CardSize = { width: 320, height: 190 }

/** 左侧边栏中部的一个典型锚点（类似 rail 图标） */
const RAIL_RECT: AnchorRect = { left: 8, top: 200, width: 56, height: 40 }

describe('computeCardPosition', () => {
  test('Given 锚点缺失 When 定位 Then 气泡在视口内居中', () => {
    const pos = computeCardPosition(null, CARD, 'auto', VIEWPORT)
    expect(pos.left).toBeCloseTo((VIEWPORT.width - CARD.width) / 2)
    expect(pos.top).toBeCloseTo((VIEWPORT.height - CARD.height) / 2)
    expect(pos.left).toBeGreaterThanOrEqual(12)
    expect(pos.top).toBeGreaterThanOrEqual(12)
  })

  test('Given 偏好右侧且空间充足 When 定位 Then 气泡在锚点右侧垂直居中', () => {
    const pos = computeCardPosition(RAIL_RECT, CARD, 'right', VIEWPORT)
    // padded.right = 8 + 56 + 8 = 72，gap 14 → 86
    expect(pos.left).toBeCloseTo(86)
    const paddedCenterY = (RAIL_RECT.top - 8 + RAIL_RECT.top + RAIL_RECT.height + 8) / 2
    expect(pos.top).toBeCloseTo(paddedCenterY - CARD.height / 2)
  })

  test('Given 底部空间充足 When auto 定位 Then 优先放锚点下方', () => {
    const rect: AnchorRect = { left: 500, top: 200, width: 200, height: 60 }
    const pos = computeCardPosition(rect, CARD, 'auto', VIEWPORT)
    // padded.bottom = 200 + 60 + 8 = 268，gap 14 → 282
    expect(pos.top).toBeCloseTo(282)
  })

  test('Given 锚点贴近底部 When auto 定位 Then 回退到锚点上方', () => {
    // 底部剩余不足 card.height：900 - (800+40+8) - 14 < 190
    const rect: AnchorRect = { left: 500, top: 800, width: 200, height: 40 }
    const pos = computeCardPosition(rect, CARD, 'auto', VIEWPORT)
    // padded.top = 792，top 放置：792 - 14 - 190 = 588
    expect(pos.top).toBeCloseTo(588)
  })

  test('Given 贴近右边缘的锚点 When 定位 Then 气泡左缘被钳制进视口', () => {
    const rect: AnchorRect = { left: 1300, top: 100, width: 120, height: 40 }
    const pos = computeCardPosition(rect, CARD, 'auto', VIEWPORT)
    expect(pos.left + CARD.width).toBeLessThanOrEqual(VIEWPORT.width - 12)
    expect(pos.left).toBeGreaterThanOrEqual(12)
  })

  test('Given 贴近右边缘且偏好 right 的锚点 When 定位 Then 回退到非 right 方位', () => {
    // rail 贴在极右侧（如右侧栏图标）：right 放不下 → 回退 bottom
    const rect: AnchorRect = { left: 1360, top: 200, width: 56, height: 40 }
    const pos = computeCardPosition(rect, CARD, 'right', VIEWPORT)
    // right 放不下时回退 bottom：top = padded.bottom + gap = 200+40+8+14
    expect(pos.top).toBeCloseTo(262)
  })

  test('Given 近乎全屏的锚点 When 定位 Then 气泡放在下缘居中而非边缘外', () => {
    const rect: AnchorRect = { left: 0, top: 0, width: 1440, height: 900 }
    const pos = computeCardPosition(rect, CARD, 'auto', VIEWPORT)
    expect(pos.left).toBeCloseTo((VIEWPORT.width - CARD.width) / 2)
    expect(pos.top).toBeCloseTo(VIEWPORT.height - CARD.height - 24)
    expect(pos.top).toBeGreaterThanOrEqual(12)
  })

  test('Given 极小视口 When 定位 Then 气泡始终留在安全边距内', () => {
    const tinyViewport: ViewportSize = { width: 360, height: 400 }
    for (const rect of [null, RAIL_RECT, { left: 0, top: 0, width: 360, height: 400 }]) {
      const pos = computeCardPosition(rect, CARD, 'auto', tinyViewport)
      expect(pos.left).toBeGreaterThanOrEqual(12)
      expect(pos.top).toBeGreaterThanOrEqual(12)
      expect(pos.left + CARD.width).toBeLessThanOrEqual(tinyViewport.width + 1)
      expect(pos.top + CARD.height).toBeLessThanOrEqual(tinyViewport.height - 12 + CARD.height) // top 钳制后不越界
      expect(pos.top).toBeLessThanOrEqual(Math.max(12, tinyViewport.height - CARD.height - 12))
    }
  })
})

describe('unionRects', () => {
  test('Given 空数组 When 联合 Then 返回 null', () => {
    expect(unionRects([])).toBeNull()
  })

  test('Given 单个矩形 When 联合 Then 返回原样', () => {
    expect(unionRects([RAIL_RECT])).toEqual(RAIL_RECT)
  })

  test('Given 上下分离的两个容器 When 联合 Then 取覆盖两者的外接矩形', () => {
    const header: AnchorRect = { left: 200, top: 80, width: 1152, height: 180 }
    const content: AnchorRect = { left: 200, top: 270, width: 1152, height: 900 }
    expect(unionRects([header, content])).toEqual({ left: 200, top: 80, width: 1152, height: 1090 })
  })

  test('Given 横向错位的两个容器 When 联合 Then 左右取极值', () => {
    const a: AnchorRect = { left: 100, top: 50, width: 300, height: 100 }
    const b: AnchorRect = { left: 500, top: 120, width: 200, height: 80 }
    expect(unionRects([a, b])).toEqual({ left: 100, top: 50, width: 600, height: 150 })
  })
})
