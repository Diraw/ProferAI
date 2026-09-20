export interface BrowserSplitGeometry {
  browserWidth: number
  conversationWidth: number
  resizeGap: number
}

/**
 * 仅在浏览器分栏自身开关变化时做宽度过渡。
 * 相邻面板收起/展开会改变容器宽度，那里必须即时跟随，否则会出现先补位再弹回。
 */
export function shouldAnimateBrowserSplitWidth(
  previousVisible: boolean,
  visible: boolean,
  dragging: boolean,
): boolean {
  return !dragging && previousVisible !== visible
}

export function resolveBrowserSplitGeometry(
  containerWidth: number,
  ratio: number,
  visible: boolean,
  options: { resizeGap: number; minConversationWidth: number; minBrowserWidth: number },
): BrowserSplitGeometry {
  if (!visible) return { browserWidth: 0, conversationWidth: Math.max(0, containerWidth), resizeGap: 0 }
  const available = Math.max(0, containerWidth - options.resizeGap)
  const minConversation = Math.min(options.minConversationWidth, available)
  const minBrowser = Math.min(options.minBrowserWidth, Math.max(0, available - minConversation))
  const unclampedConversation = available * ratio
  const conversationWidth = Math.round(Math.max(minConversation, Math.min(available - minBrowser, unclampedConversation)))
  return {
    conversationWidth,
    browserWidth: Math.max(0, available - conversationWidth),
    resizeGap: options.resizeGap,
  }
}
