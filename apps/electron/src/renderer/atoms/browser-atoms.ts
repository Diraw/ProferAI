import { atom } from 'jotai'
import type { BrowserViewState } from '@profer/shared'

/** 每个 Agent 会话的浏览器状态镜像。主进程仍是状态权威（BROWSER_STATE_CHANGED 推送）。 */
export const browserStateMapAtom = atom<Map<string, BrowserViewState>>(new Map())

/**
 * 用户已手动关闭浏览器 Tab 的会话 ID 集合。
 * 主进程 BROWSER_STATE_CHANGED 推送不应强制重开用户刚关掉的 Tab；
 * 用户再次点浏览器入口（手动打开会清除标记）也可恢复。
 */
export const browserPanelDismissedSessionIdsAtom = atom<Set<string>>(new Set<string>())

/**
 * 当前挂载了原生 WebContentsView 的浏览器顶栏 Tab id 集合。
 *
 * 这些页的右下角退出按钮由主进程绘制在原生网页之上；renderer 的 DOM 按钮必须隐藏，
 * 否则会在网页下方的面板底部再露出一个，形成两个关闭按钮。
 */
export const browserNativePaneTabIdsAtom = atom<ReadonlySet<string>>(new Set<string>())
