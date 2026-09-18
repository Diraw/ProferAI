import { expect, test } from 'bun:test'
import type { BrowserViewState } from '@profer/shared'
import { normalizeStartPageInput, shouldNavigateDefaultHome } from './browser-start-page-navigation'

function browserState(overrides: Partial<BrowserViewState> = {}): BrowserViewState {
  return {
    sessionId: 'session-1',
    executionSource: 'user',
    activeTabId: 'tab-1',
    agentTabId: null,
    tabs: [],
    url: '',
    title: '新建标签页',
    localFile: null,
    loading: false,
    visible: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    translated: false,
    loadError: null,
    trace: [],
    activity: null,
    ...overrides,
  }
}

test('默认首页不会为尚未打开浏览器的新 Agent 会话创建浏览器', () => {
  expect(shouldNavigateDefaultHome(null, 'https://www.example.com', null)).toBeFalse()
})

test('默认首页只导航一次已存在的空标签', () => {
  const state = browserState()
  expect(shouldNavigateDefaultHome(state, 'https://www.example.com', null)).toBeTrue()
  expect(shouldNavigateDefaultHome(state, 'https://www.example.com', state.activeTabId)).toBeFalse()
})

test('已有网页内容的标签不会被默认首页覆盖', () => {
  expect(shouldNavigateDefaultHome(browserState({ url: 'https://www.bilibili.com/' }), 'https://www.example.com', null)).toBeFalse()
})

const BING = 'https://www.bing.com/search?q='

test('起始页把本机与局域网开发地址按 HTTP 打开', () => {
  expect(normalizeStartPageInput('127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
  expect(normalizeStartPageInput('localhost:5173/app')).toBe('http://localhost:5173/app')
  expect(normalizeStartPageInput('[::1]:8080')).toBe('http://[::1]:8080')
  expect(normalizeStartPageInput('192.168.1.10:8080')).toBe('http://192.168.1.10:8080')
  expect(normalizeStartPageInput('10.0.0.5')).toBe('http://10.0.0.5')
  expect(normalizeStartPageInput('172.16.0.9:3000')).toBe('http://172.16.0.9:3000')
  expect(normalizeStartPageInput('dev-machine.local:3000')).toBe('http://dev-machine.local:3000')
})

test('起始页不会把局域网地址当成搜索词或错误补成 HTTPS', () => {
  // 这两个是本次修复的核心回归：以前会跳到 Bing，或补成连不上的 HTTPS。
  expect(normalizeStartPageInput('192.168.1.10:8080')).not.toStartWith(BING)
  expect(normalizeStartPageInput('192.168.1.10:8080')).not.toStartWith('https://')
})

test('起始页公网域名仍默认 HTTPS，其余输入走搜索', () => {
  expect(normalizeStartPageInput('example.com/docs')).toBe('https://example.com/docs')
  expect(normalizeStartPageInput('bilibili.com')).toBe('https://bilibili.com')
  expect(normalizeStartPageInput('https://example.com/a')).toBe('https://example.com/a')
  expect(normalizeStartPageInput('如何写单测')).toBe(`${BING}${encodeURIComponent('如何写单测')}`)
  expect(normalizeStartPageInput('   ')).toBe('')
})
