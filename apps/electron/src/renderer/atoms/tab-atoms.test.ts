import { expect, test } from 'bun:test'
import { closeTab, createPluginTabId, getPersistableTabState, openPluginTab, type TabItem } from './tab-atoms'

const tab = (id: string): TabItem => ({ id, type: 'agent', sessionId: id, title: id })

test('关闭当前普通标签时回退到最近访问标签而非右侧标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b'), tab('c')], 'c', 'c', ['c', 'b', 'a'])
  expect(result.activeTabId).toBe('b')
  expect(result.mru).toEqual(['b', 'a'])
})

test('关闭非当前标签不改变活动标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b')], 'a', 'b', ['a', 'b'])
  expect(result.activeTabId).toBe('a')
  expect(result.mru).toEqual(['a'])
})

test('打开插件页时生成稳定 Tab，且插件 Tab 不写入会话持久化', () => {
  const result = openPluginTab([], { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo' })
  expect(result.activeTabId).toBe(createPluginTabId('com.example.demo', 'dashboard'))
  expect(result.tabs.map((item) => item.type)).toEqual(['scratch', 'plugin'])
  expect(getPersistableTabState(result.tabs, result.activeTabId)).toEqual({ tabs: [], activeTabId: null })
})

test('重复打开同一个插件页只聚焦已有 Tab', () => {
  const first = openPluginTab([], { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo' })
  const second = openPluginTab(first.tabs, { pluginId: 'com.example.demo', pageId: 'dashboard', title: 'Demo' })
  expect(second.tabs).toHaveLength(2)
  expect(second.activeTabId).toBe(first.activeTabId)
})
