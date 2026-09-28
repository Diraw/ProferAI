/**
 * Tab 悬浮预览面板的横向落点求解。
 *
 * 受管浏览器是原生 WebContentsView，渲染层级在整棵 DOM 之上：预览面板（Portal）
 * 一旦与原生网页区域相交，相交部分会被原生视图直接盖住（用户表现为
 * 「没有东西能在浏览器上面显示」）。这里在知道面板宽度/高度与原生页面
 * 占位矩形（[data-browser-native-page]）后，求解一个不遮挡的 left：
 * - 首选期望位置；不遮挡就用；
 * - 遮挡时尝试每个原生矩形的左空当 / 右空当，以及窗口左右边界，
 *   取离期望位置最近且不遮挡的候选；
 * - 全部候选都遮挡（原生区域几乎铺满主区）时回落期望位置，由调用方接受裁剪。
 */

export interface NativePageRect {
  left: number
  right: number
  top: number
  bottom: number
}

const EDGE_GAP = 8
/** 相交判定留 1px 余量，避免贴边时的亚像素误伤 */
const OVERLAP_EPSILON = 1

export interface ResolveTabPreviewLeftInput {
  desiredLeft: number
  panelWidth: number
  panelTop: number
  panelHeight: number
  hostRects: NativePageRect[]
  viewportWidth: number
}

export function resolveTabPreviewLeft(input: ResolveTabPreviewLeftInput): number {
  const { panelWidth, viewportWidth } = input
  const minLeft = EDGE_GAP
  const maxLeft = Math.max(minLeft, viewportWidth - panelWidth - EDGE_GAP)
  const clamp = (left: number): number => Math.min(Math.max(left, minLeft), maxLeft)

  const desired = clamp(input.desiredLeft)
  const panelBottom = input.panelTop + input.panelHeight

  const overlaps = (left: number, rect: NativePageRect): boolean => (
    left < rect.right - OVERLAP_EPSILON
    && left + panelWidth > rect.left + OVERLAP_EPSILON
    && input.panelTop < rect.bottom - OVERLAP_EPSILON
    && panelBottom > rect.top + OVERLAP_EPSILON
  )
  const clashing = (left: number): boolean => input.hostRects.some((rect) => overlaps(left, rect))

  if (!clashing(desired)) return desired

  const candidates: number[] = []
  for (const rect of input.hostRects) {
    candidates.push(clamp(rect.left - panelWidth - EDGE_GAP), clamp(rect.right + EDGE_GAP))
  }
  candidates.push(minLeft, maxLeft)

  let best: number | null = null
  for (const candidate of candidates) {
    if (clashing(candidate)) continue
    if (best === null || Math.abs(candidate - desired) < Math.abs(best - desired)) best = candidate
  }
  return best ?? desired
}

/** 读取当前原生网页占位矩形（仅保留有实际尺寸的；隐藏面板的占位是 0 宽）。 */
export function readNativePageRects(): NativePageRect[] {
  const rects: NativePageRect[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-browser-native-page]')) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 4 || rect.height <= 4) continue
    rects.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }
  return rects
}
