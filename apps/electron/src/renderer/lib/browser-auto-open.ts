import type { BrowserViewState } from '@profer/shared'

/**
 * 能代表「浏览器工作已经实际开始」的展示型动作。
 *
 * 只读动作（observe / wait / screenshot / dom inspect / script）不会产生新的可见页面，
 * 因此不应改变用户界面；否则模型一次误调用就会把浏览器面板顶出来。
 */
const BROWSER_DISPLAY_ACTIONS: ReadonlySet<string> = new Set(['navigate', 'tab'])

/**
 * 判断一次主进程 BROWSER_STATE_CHANGED 推送是否应自动打开浏览器面板。
 *
 * 两道防线中的第二道：主进程已不再为只读查询广播状态（BrowserListTabs 是无副作用查询），
 * 这里再要求「当前会话确实有 Agent 工作标签」且「最近一次操作是 navigate/tab」，
 * 防止未来任何只读状态同步重新触发 UI。
 *
 * 注意：切回会话时由 getAgentBrowserState 恢复已有浏览器的路径不走这里，
 * 那条路径是「用户回到该会话」的显式意图，仍需保留自动恢复。
 */
export function shouldAutoOpenBrowserFromPush(
  state: Pick<BrowserViewState, 'agentTabId' | 'tabs' | 'activity'>,
): boolean {
  if (!state.agentTabId) return false
  // 工作标签必须真实存在：会话被销毁但状态晚到时不能打开空白面板。
  if (!state.tabs.some((tab) => tab.tabId === state.agentTabId)) return false
  const action = state.activity?.action
  return action !== undefined && BROWSER_DISPLAY_ACTIONS.has(action)
}
