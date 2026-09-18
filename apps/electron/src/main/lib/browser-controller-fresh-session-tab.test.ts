import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserController } from './browser-controller'

/**
 * 「新建标签页」一次只该落一个标签。
 *
 * 现场：会话里还没有任何浏览器标签时（面板刚打开、或刚在列里预览了本地文件 —— 后者根本不
 * 走主进程，所以主进程里也还没有这个浏览器会话），用户点一次「新建标签页」会看到**两个**
 * 空白标签。
 *
 * 根因：`getOrCreateSession` 会给空会话预建一个标签（navigate/observe/click 这类操作都假定
 * 「已有一个标签」），而 `createDisplayTab` / `createNewTab` / `previewOpen` 自己紧接着又
 * `createTab` —— 于是两次建标签。修复是让这三个调用方把 `ensureInitialTab` 传 false。
 *
 * 这里把 `createTab` / `activateDisplayTab` / `buildState` 都换成只数标签的替身：本用例关心的是
 * 「建了几个标签」，不是标签里的 WebContents（那需要真的 Electron 进程）。
 */
interface FakeTab {
  tabId: string
  state: { trace: unknown[] }
}

function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profer-fresh-session-tab-')))
  const docPath = join(root, 'sample-legacy.doc')
  writeFileSync(docPath, 'fake doc content')

  const makeSession = (tabs: FakeTab[]) => ({
    sessionId: 'session-1',
    allowedRoots: [root],
    ledger: [] as unknown[],
    executionSource: 'user',
    tabs: new Map(tabs.map((tab) => [tab.tabId, tab])),
    activeTabId: tabs[0]?.tabId ?? '',
    agentTabId: tabs[0]?.tabId ?? null,
    tabMru: tabs.map((tab) => tab.tabId),
    agentAbortController: new AbortController(),
  })

  const fresh = makeSession([])
  let counter = 0
  let emitCount = 0
  let emittedBeforeFirstTab = false
  const controller = new BrowserController()
  const internals = controller as unknown as {
    sessions: Map<string, ReturnType<typeof makeSession>>
    emit: () => void
    assertRiskDisclaimerAcknowledged: () => void
    markUserBrowserContext: () => void
    reclaimExcessAgentTabs: () => number
    loadUrl: () => Promise<void>
    updateNavigationState: () => void
    runTabOperation: (
      session: unknown,
      tab: unknown,
      signal: unknown,
      operation: (signal: AbortSignal) => Promise<unknown>,
    ) => Promise<unknown>
    createTab: (session: ReturnType<typeof makeSession>, isLocalPreview?: boolean, claimAsAgent?: boolean) => FakeTab
    activateDisplayTab: (session: ReturnType<typeof makeSession>, tab: FakeTab) => void
    buildState: (session: ReturnType<typeof makeSession>) => unknown
  }
  internals.sessions = new Map([[fresh.sessionId, fresh]])
  internals.emit = () => { emitCount += 1 }
  // 风险告知与回收策略与本用例无关，换成替身，避免为它们伪造整份设置/标签状态
  internals.assertRiskDisclaimerAcknowledged = () => undefined
  internals.markUserBrowserContext = () => undefined
  internals.reclaimExcessAgentTabs = () => 0
  internals.loadUrl = async () => undefined
  internals.updateNavigationState = () => undefined
  internals.runTabOperation = async (_session, _tab, _signal, operation) => operation(new AbortController().signal)
  internals.createTab = (session, _isLocalPreview, claimAsAgent) => {
    if (emitCount > 0) emittedBeforeFirstTab = true
    counter += 1
    const tab: FakeTab = { tabId: `tab-${counter}`, state: { trace: [] } }
    session.tabs.set(tab.tabId, tab)
    if (!session.activeTabId) session.activeTabId = tab.tabId
    if (claimAsAgent) session.agentTabId = tab.tabId
    return tab
  }
  internals.activateDisplayTab = () => undefined
  internals.buildState = (session) => ({ tabs: [...session.tabs.values()].map((tab) => ({ tabId: tab.tabId })) })

  return { controller, fresh, docPath, tabIds: () => [...fresh.tabs.keys()], emittedBeforeFirstTab: () => emittedBeforeFirstTab }
}

test('冷会话 + 用户点「新建标签页」：只落一个标签（曾经是两个空白标签）', async () => {
  const h = harness()

  const state = await h.controller.createDisplayTab('session-1')

  expect(h.tabIds()).toEqual(['tab-1'])
  expect(h.emittedBeforeFirstTab()).toBe(false)
  expect((state as { tabs: unknown[] }).tabs).toHaveLength(1)
})

test('冷会话 + Agent 新建工作标签：同样只落一个', async () => {
  const h = harness()

  await h.controller.createNewTab('session-1')

  expect(h.tabIds()).toEqual(['tab-1'])
  expect(h.emittedBeforeFirstTab()).toBe(false)
})

test('冷会话 + 打开本地文件预览（viewer 页路径）：只落预览标签', async () => {
  const h = harness()

  await h.controller.previewOpen('session-1', h.docPath, undefined, [join(h.docPath, '..')])

  expect(h.tabIds()).toHaveLength(1)
  expect(h.emittedBeforeFirstTab()).toBe(false)
})

test('已有标签的会话：新建标签是在原有之上加一个，不会顶掉已有标签', async () => {
  const h = harness()
  await h.controller.createDisplayTab('session-1')
  await h.controller.createDisplayTab('session-1')

  expect(h.tabIds()).toEqual(['tab-1', 'tab-2'])
})
