/**
 * 计算 scroll viewport 尺寸变化时，贴底消息列表应写入的 scrollTop。
 *
 * use-stick-to-bottom 的 ResizeObserver 只观察**内容**高度；窗口 resize 改变的是滚动
 * 元素 `clientHeight`，内容高度不变时库不会主动补偿，于是贴底列表会随着窗口变矮不断
 * 落后于底部目标。
 *
 * 这里只负责“该写多少”的纯计算，便于单测；写入时机与状态判断由调用方负责。
 */

/** 小于该偏差视为已贴底，避免设备像素比取整造成的无意义写入。 */
export const VIEWPORT_FOLLOW_EPSILON_PX = 0.5

export interface ViewportResizeFollowInput {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  isAtBottom: boolean
}

/**
 * @returns 需要写入的 scrollTop；已经贴底或用户不在底部时返回 null。
 */
export function getViewportResizeFollowTarget({
  scrollHeight,
  clientHeight,
  scrollTop,
  isAtBottom,
}: ViewportResizeFollowInput): number | null {
  // 用户正在翻历史消息时绝不抢滚动位置。
  if (!isAtBottom) return null

  // 与 use-stick-to-bottom 的 targetScrollTop 保持同一定义（-1 用于避开 overscroll）。
  const target = Math.max(0, scrollHeight - 1 - clientHeight)
  return Math.abs(scrollTop - target) < VIEWPORT_FOLLOW_EPSILON_PX ? null : target
}
