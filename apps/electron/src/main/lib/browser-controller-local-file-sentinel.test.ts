import { expect, test } from 'bun:test'

import {
  AGENT_IPC_CHANNELS,
  BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS,
  type BrowserLocalFileSelectionEvent,
} from '@profer/shared'

import { BrowserController } from './browser-controller'

/**
 * viewer 页（无 preload 的沙箱页）只能靠哨兵 URL 把划词交给主进程，
 * 主进程这里就是**信任边界**：必须只放行本地预览标签自己的文件，其余一律忽略。
 */
function harness(options: { isLocalPreview: boolean; localFilePath: string | null }) {
  const sent: BrowserLocalFileSelectionEvent[] = []
  const owner = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === AGENT_IPC_CHANNELS.BROWSER_LOCAL_FILE_SELECTION) {
          sent.push(payload as BrowserLocalFileSelectionEvent)
        }
      },
    },
  }
  const tab = {
    tabId: 'tab-1',
    isLocalPreview: options.isLocalPreview,
    localFilePath: options.localFilePath,
    lastActivityAt: 0,
    state: { url: 'profer-file://token', trace: [] as unknown[] },
  }
  const browserSession = {
    sessionId: 'session-1',
    ledger: [] as unknown[],
    executionSource: 'user',
    tabs: new Map([[tab.tabId, tab]]),
    activeTabId: tab.tabId,
    agentTabId: tab.tabId,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    emit: () => void
    forwardLocalFileSelection: (session: unknown, tab: unknown, url: string) => void
  }
  internals.owner = owner
  internals.emit = () => undefined // 状态广播与本用例无关，避免为它伪造整份标签状态
  return {
    sent,
    forward: (url: string) => internals.forwardLocalFileSelection(browserSession, tab, url),
    traces: () => (tab.state.trace as Array<{ summary: string }>).map((item) => item.summary),
  }
}

test('本地预览标签的划词回投：文本与文件信息转给渲染进程', () => {
  const h = harness({ isLocalPreview: true, localFilePath: '/tmp/samples/sample-legacy.doc' })
  const text = '第一段\n第二段 with spaces'
  h.forward(`profer-selection://${encodeURIComponent(text)}`)

  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]).toEqual({
    sessionId: 'session-1',
    text,
    filePath: '/tmp/samples/sample-legacy.doc',
    fileName: 'sample-legacy.doc',
  })
})

test('选区清空（空串）也要转投，渲染进程据此撤掉引用胶囊', () => {
  const h = harness({ isLocalPreview: true, localFilePath: '/tmp/samples/sample.zip' })
  h.forward('profer-selection://')

  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]?.text).toBe('')
})

test('非本地预览标签（普通网页）一律忽略：网页无法借哨兵把内容塞进对话', () => {
  const h = harness({ isLocalPreview: false, localFilePath: null })
  h.forward(`profer-selection://${encodeURIComponent('site text')}`)

  expect(h.sent).toEqual([])
})

test('本地预览标签但缺路径时忽略', () => {
  const h = harness({ isLocalPreview: true, localFilePath: null })
  h.forward(`profer-selection://${encodeURIComponent('text')}`)

  expect(h.sent).toEqual([])
})

test('畸形百分号编码忽略，不抛异常', () => {
  const h = harness({ isLocalPreview: true, localFilePath: '/tmp/samples/sample.zip' })
  h.forward('profer-selection://%E4%BD')

  expect(h.sent).toEqual([])
  expect(h.traces().some((summary) => summary.includes('畸形'))).toBe(true)
})

test('超长划词按上限截断后再转投', () => {
  const h = harness({ isLocalPreview: true, localFilePath: '/tmp/samples/sample.zip' })
  const long = 'x'.repeat(BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS + 800)
  h.forward(`profer-selection://${encodeURIComponent(long)}`)

  expect(h.sent).toHaveLength(1)
  expect(h.sent[0]?.text).toHaveLength(BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS)
})
