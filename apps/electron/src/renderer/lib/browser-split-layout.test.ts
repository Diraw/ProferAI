import { expect, test } from 'bun:test'
import { resolveBrowserSplitGeometry, shouldAnimateBrowserSplitWidth } from './browser-split-layout'

const options = { resizeGap: 8, minConversationWidth: 420, minBrowserWidth: 360 }

test('相邻面板改变容器宽度时不启用浏览器宽度过渡', () => {
  expect(shouldAnimateBrowserSplitWidth(true, true, false)).toBe(false)
})

test('浏览器自身开关变化时启用宽度过渡', () => {
  expect(shouldAnimateBrowserSplitWidth(false, true, false)).toBe(true)
  expect(shouldAnimateBrowserSplitWidth(true, false, false)).toBe(true)
})

test('拖拽浏览器分栏时禁用宽度过渡', () => {
  expect(shouldAnimateBrowserSplitWidth(false, true, true)).toBe(false)
})

test('浏览器隐藏时对话区占满容器', () => {
  expect(resolveBrowserSplitGeometry(1200, 0.58, false, options)).toEqual({ browserWidth: 0, conversationWidth: 1200, resizeGap: 0 })
})

test('浏览器显示时精确预留中缝', () => {
  expect(resolveBrowserSplitGeometry(1200, 0.58, true, options)).toEqual({ browserWidth: 501, conversationWidth: 691, resizeGap: 8 })
})

test('极端比例仍遵守最小面板宽度', () => {
  expect(resolveBrowserSplitGeometry(1000, 0.98, true, options)).toEqual({ browserWidth: 360, conversationWidth: 632, resizeGap: 8 })
})

test('窄窗口不产生负几何', () => {
  expect(resolveBrowserSplitGeometry(100, 0.5, true, options)).toEqual({ browserWidth: 0, conversationWidth: 92, resizeGap: 8 })
})
