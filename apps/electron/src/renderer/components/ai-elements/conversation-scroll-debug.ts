/**
 * 对话滚动 resize 调试开关。
 *
 * **开发构建默认关闭**：观测本身每帧要遍历全部消息元素、多次 getBoundingClientRect、
 * 拼 JSON 并 console.info（经 IPC 到主进程落盘），在拖拽窗口时这层开销自身就会制造卡顿，
 * 干扰对“界面是否真的抖”的判断。
 *
 * 需要观测时显式开启（二选一）：
 * - URL 加 `?conversationScrollDebug=1`；
 * - 启动 dev server 前设 `VITE_CONVERSATION_SCROLL_DEBUG=1`。
 *
 * 结构锚定实验仍需显式指定 `conversationScrollAnchor=none`。生产构建恒为关闭。
 */

export type ConversationScrollAnchorMode = 'auto' | 'none'

export interface ConversationScrollDebugOptions {
  enabled: boolean
  scrollAnchor: ConversationScrollAnchorMode
}

const DISABLED_OPTIONS: ConversationScrollDebugOptions = {
  enabled: false,
  scrollAnchor: 'auto',
}

export function getConversationScrollDebugOptions(
  search: string,
  isDevelopment: boolean,
  envEnabled = false,
): ConversationScrollDebugOptions {
  if (!isDevelopment) return DISABLED_OPTIONS

  const params = new URLSearchParams(search)

  return {
    enabled: params.get('conversationScrollDebug') === '1' || envEnabled,
    scrollAnchor: params.get('conversationScrollAnchor') === 'none' ? 'none' : 'auto',
  }
}
