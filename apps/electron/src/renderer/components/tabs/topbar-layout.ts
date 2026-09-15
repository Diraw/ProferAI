export const TOPBAR_HEIGHT = 40
export const TOPBAR_CONTENT_HEIGHT = 37

/**
 * 右侧操作胶囊与顶栏右缘的间距。
 *
 * 三个地方必须共用同一数值，否则会出现「Tab 滚到胶囊下面」或「拖拽层压住窗口按钮」：
 * - `.topbar-actions-slot { right: 12px }`
 * - `.topbar-tabs-scroll { padding-right: calc(操作区宽度 + 12px) }`
 * - `.topbar-drag-surface { right: calc(操作区宽度 + 12px) }`
 */
export const TOPBAR_ACTIONS_EDGE_GAP = 12

/**
 * 内容行的起始偏移（整数 CSS px）。
 *
 * 40px 外框放 37px 内容行时 (40 - 37) / 2 = 1.5，用 `top-1/2 + translateY(-50%)`
 * 会让拖拽层和窗口按钮落在半像素边界上；叠加主窗口固定的 110% renderer zoom 与
 * Windows 125%/150%/175% 缩放后全部变成非整数物理像素，是命中区误判的温床。
 * 这里向下取整成 1px（顶部 1px、底部 2px），视觉差 0.5px 不可见，几何全是整数。
 */
export const TOPBAR_CONTENT_OFFSET = Math.floor(
  (TOPBAR_HEIGHT - TOPBAR_CONTENT_HEIGHT) / 2,
)

export interface TopBarGeometryInput {
  frameHeight?: number
  contentHeight?: number
  brandWidth: number
  actionWidth: number
  availableWidth: number
}

export interface TopBarGeometry {
  frameHeight: number
  contentHeight: number
  /** 内容行起始偏移，始终为整数 CSS px。 */
  contentOffset: number
  /** 内容行下方剩余高度。 */
  bottomGutter: number
  tabsViewportWidth: number
}

/**
 * 默认顶栏保持 40px 外框、37px 内容行；横向列宽由真实 brand/action slot 决定，不能通过垂直偏移或负 margin 补偿。
 * 垂直方向不放使用半像素居中：偏移用整数，剩余高度落到下边距。
 */
export function resolveTopBarGeometry({
  frameHeight = TOPBAR_HEIGHT,
  contentHeight = TOPBAR_CONTENT_HEIGHT,
  brandWidth,
  actionWidth,
  availableWidth,
}: TopBarGeometryInput): TopBarGeometry {
  const safeFrameHeight = Math.max(0, frameHeight)
  const safeContentHeight = Math.min(Math.max(0, contentHeight), safeFrameHeight)
  const contentOffset = Math.floor((safeFrameHeight - safeContentHeight) / 2)
  const bottomGutter = safeFrameHeight - safeContentHeight - contentOffset
  const tabsViewportWidth = Math.max(0, availableWidth - Math.max(0, brandWidth) - Math.max(0, actionWidth))

  return {
    frameHeight: safeFrameHeight,
    contentHeight: safeContentHeight,
    contentOffset,
    bottomGutter,
    tabsViewportWidth,
  }
}

/**
 * 拖拽层必须为右侧操作胶囊让开的宽度（操作区实测宽度 + 边缘间距）。
 *
 * 拖拽矩形与操作胶囊（内含 Windows 窗口按钮）必须几何相邻而不重叠：
 * 重叠时只能靠 no-drag 从 drag 里再扣掉按钮矩形，正是高 DPI 点击失效的成因。
 */
export function resolveTopBarDragRightInset(actionsWidth: number): number {
  return Math.max(0, actionsWidth) + TOPBAR_ACTIONS_EDGE_GAP
}
