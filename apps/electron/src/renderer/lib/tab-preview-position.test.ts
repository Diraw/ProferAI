/**
 * tab-preview-position 单测 —— Tab 悬浮预览避开原生浏览器视图的横向落点。
 */

import { expect, test } from 'bun:test'
import { resolveTabPreviewLeft, type NativePageRect } from './tab-preview-position'

const hostRight: NativePageRect = { left: 800, right: 1400, top: 40, bottom: 900 }
const hostLeft: NativePageRect = { left: 40, right: 600, top: 40, bottom: 900 }

const base = {
  panelWidth: 280,
  panelTop: 40,
  panelHeight: 420,
  viewportWidth: 1440,
}

test('不遮挡原生区域时保持期望位置', () => {
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: 100, hostRects: [hostRight] })).toBe(100)
})

test('没有原生区域（浏览器未打开）时只夹窗口边界', () => {
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: 300, hostRects: [] })).toBe(300)
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: 9999, hostRects: [] })).toBe(1440 - 280 - 8)
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: -50, hostRects: [] })).toBe(8)
})

test('与右栏浏览器相交时避让到其左侧空当', () => {
  // 期望位置 700 → 面板 [700, 980] 与宿主 [800, 1400] 相交
  // 候选：宿主左空当 left = 800 - 280 - 8 = 512（不相交），应选它
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: 700, hostRects: [hostRight] })).toBe(512)
})

test('与左栏浏览器相交且左侧放不下时避让到其右侧', () => {
  // 面板 [400, 680] 与宿主 [40, 600] 相交；宿主左空当 8 ~ - 放不下（600-280-8=312 处仍相交）
  // 宿主右空当 left = 600 + 8 = 608 不相交
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: 400, hostRects: [hostLeft] })).toBe(608)
})

test('竖向不相交（面板在原生区域下方）不算遮挡', () => {
  const lowHost: NativePageRect = { left: 0, right: 1400, top: 500, bottom: 900 }
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: 700, panelTop: 40, panelHeight: 100, hostRects: [lowHost] })).toBe(700)
})

test('原生区域铺满主区、两侧都放不下时回落期望位置（接受裁剪）', () => {
  const fullHost: NativePageRect = { left: 0, right: 1440, top: 0, bottom: 900 }
  expect(resolveTabPreviewLeft({ ...base, desiredLeft: 700, hostRects: [fullHost] })).toBe(700)
})
