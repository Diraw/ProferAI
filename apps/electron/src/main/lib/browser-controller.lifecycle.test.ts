import { expect, test } from 'bun:test'
import { BrowserController } from './browser-controller'

test('关闭最后一个标签时移除原生 hostView，避免透明区域继续拦截全局点击', async () => {
  const calls = {
    hostVisible: [] as boolean[],
    hostBounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
    removedChildren: [] as unknown[],
    removedHosts: [] as unknown[],
    tabClosed: 0,
  }
  const hostView = {
    setVisible: (visible: boolean) => calls.hostVisible.push(visible),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => calls.hostBounds.push(bounds),
    removeChildView: (view: unknown) => calls.removedChildren.push(view),
  }
  const webContents = {
    debugger: { isAttached: () => false, detach: () => undefined },
    isDestroyed: () => false,
    close: () => { calls.tabClosed += 1 },
  }
  const tab = {
    tabId: 'tab-1',
    view: { webContents, setVisible: () => undefined },
    state: { visible: true },
  }
  const browserSession = {
    sessionId: 'session-1',
    tabs: new Map([[tab.tabId, tab]]),
    activeTabId: tab.tabId,
    agentTabId: tab.tabId,
    hostView,
    lastVisible: true,
  }
  const owner = {
    isDestroyed: () => false,
    contentView: { removeChildView: (view: unknown) => calls.removedHosts.push(view) },
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    foregroundSessionId: string | null
    sessions: Map<string, typeof browserSession>
  }
  internals.owner = owner
  internals.foregroundSessionId = browserSession.sessionId
  internals.sessions.set(browserSession.sessionId, browserSession)

  expect(await controller.closeTab(browserSession.sessionId, tab.tabId)).toBeNull()
  expect(controller.getState(browserSession.sessionId)).toBeNull()
  // 浏览器 session 已销毁，但当前前台 Agent 会话所有权必须保留；否则同会话重新打开后
  // 新的 native layout 会被主进程误判为后台，表现为空白无画面。
  expect(internals.foregroundSessionId).toBe(browserSession.sessionId)
  expect(calls.hostVisible).toEqual([false])
  expect(calls.hostBounds).toEqual([{ x: 0, y: 0, width: 0, height: 0 }])
  expect(calls.removedChildren).toEqual([tab.view])
  expect(calls.removedHosts).toEqual([hostView])
  expect(calls.tabClosed).toBe(1)
})

test('没有浏览器会话时 listTabs 只读：不创建 session/tab，也不广播状态', () => {
  const sent: unknown[] = []
  const owner = {
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => { sent.push(args) } },
    contentView: {
      // 创建原生视图即视为副作用：这里直接失败，确保只读查询不会走到 createSession。
      addChildView: () => { throw new Error('listTabs 不应创建原生浏览器视图') },
      removeChildView: () => undefined,
    },
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    sessions: Map<string, unknown>
  }
  internals.owner = owner

  const result = controller.listTabs('session-without-browser')

  expect(result).toEqual({
    sessionId: 'session-without-browser',
    exists: false,
    activeTabId: null,
    agentTabId: null,
    tabs: [],
  })
  expect(internals.sessions.size).toBe(0)
  expect(sent).toEqual([])
})

test('已有浏览器会话时 listTabs 只投影现有标签：不新建标签、不广播状态', () => {
  const sent: unknown[] = []
  const owner = {
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => { sent.push(args) } },
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  }
  const agentTab = {
    tabId: 'tab-agent',
    state: { url: 'https://example.com/', title: '示例页', loading: false },
    zoomFactor: 1,
    openedByAgent: true,
  }
  const userTab = {
    tabId: 'tab-user',
    state: { url: '', title: '新建标签页', loading: true },
    zoomFactor: 1.25,
    openedByAgent: false,
  }
  const browserSession = {
    sessionId: 'session-1',
    tabs: new Map([[agentTab.tabId, agentTab], [userTab.tabId, userTab]]),
    activeTabId: userTab.tabId,
    agentTabId: agentTab.tabId,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    sessions: Map<string, typeof browserSession>
  }
  internals.owner = owner
  internals.sessions.set(browserSession.sessionId, browserSession)

  const result = controller.listTabs(browserSession.sessionId)

  expect(result.exists).toBe(true)
  expect(result.activeTabId).toBe('tab-user')
  expect(result.agentTabId).toBe('tab-agent')
  expect(result.tabs.map((tab) => tab.tabId)).toEqual(['tab-agent', 'tab-user'])
  expect(result.tabs[0]).toMatchObject({ tabId: 'tab-agent', url: 'https://example.com/', title: '示例页', openedByAgent: true })
  expect(result.tabs[1]).toMatchObject({ tabId: 'tab-user', zoomFactor: 1.25, openedByAgent: false })
  // 原有标签未被回收或新增，也没有任何状态推送。
  expect(browserSession.tabs.size).toBe(2)
  expect(sent).toEqual([])
})

test('会话记录存在但 activeTabId 已失效时 listTabs 返回可判定的空值', () => {
  const owner = {
    isDestroyed: () => false,
    webContents: { send: () => undefined },
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  }
  const staleTab = {
    tabId: 'tab-closing',
    state: { url: '', title: '关闭中', loading: false },
    zoomFactor: 1,
    openedByAgent: true,
  }
  const browserSession = {
    sessionId: 'session-stale',
    tabs: new Map([[staleTab.tabId, staleTab]]),
    activeTabId: 'tab-already-disposed',
    agentTabId: null,
  }
  const controller = new BrowserController()
  const internals = controller as unknown as {
    owner: typeof owner
    sessions: Map<string, typeof browserSession>
  }
  internals.owner = owner
  internals.sessions.set(browserSession.sessionId, browserSession)

  const result = controller.listTabs(browserSession.sessionId)

  expect(result.exists).toBe(true)
  expect(result.activeTabId).toBeNull()
  expect(result.agentTabId).toBeNull()
  expect(result.tabs.map((tab) => tab.tabId)).toEqual(['tab-closing'])
})
