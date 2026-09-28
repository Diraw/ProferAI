/**
 * coach-tour-position — CoachTour 的纯几何逻辑
 *
 * 从 Overlay 组件中抽出，不依赖 React/DOM，便于 bun test 固化
 * 方位回退与视口钳制规则（改 UI 布局时不至于悄悄崩掉）。
 */

export interface AnchorRect {
  left: number
  top: number
  width: number
  height: number
}

export interface CardSize {
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export type CoachTourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto'

const SPOTLIGHT_PADDING = 8
const CARD_GAP = 14
const VIEWPORT_MARGIN = 12

/**
 * 计算气泡位置：
 * 1. 锚点缺失 → 视口居中（降级，不阻断流程）
 * 2. 锚点近乎全屏（≥80% 面积）→ 卡在其下缘居中（遮罩环贴着屏幕边缘，气泡放底部不挡内容）
 * 3. 偏好方位空间不足时按 bottom → top → right → left 回退
 * 4. 最后钳制进视口安全边距
 */
export function computeCardPosition(
  rect: AnchorRect | null,
  card: CardSize,
  placement: CoachTourPlacement,
  viewport: ViewportSize,
): { left: number; top: number } {
  const vw = viewport.width
  const vh = viewport.height
  if (!rect) {
    return {
      left: Math.max(VIEWPORT_MARGIN, (vw - card.width) / 2),
      top: Math.max(VIEWPORT_MARGIN, (vh - card.height) / 2),
    }
  }

  if (rect.width * rect.height >= vw * vh * 0.8) {
    return {
      left: clamp((vw - card.width) / 2, VIEWPORT_MARGIN, vw - card.width - VIEWPORT_MARGIN),
      top: clamp(vh - card.height - VIEWPORT_MARGIN * 2, VIEWPORT_MARGIN, vh - card.height - VIEWPORT_MARGIN),
    }
  }

  const padded = {
    left: rect.left - SPOTLIGHT_PADDING,
    top: rect.top - SPOTLIGHT_PADDING,
    right: rect.left + rect.width + SPOTLIGHT_PADDING,
    bottom: rect.top + rect.height + SPOTLIGHT_PADDING,
  }
  const candidates: Exclude<CoachTourPlacement, 'auto'>[] = placement === 'auto'
    ? ['bottom', 'top', 'right', 'left']
    : [placement, 'bottom', 'top', 'right', 'left']
  let chosen: Exclude<CoachTourPlacement, 'auto'> = candidates[0] ?? 'bottom'
  for (const candidate of candidates) {
    if (candidate === 'bottom' && padded.bottom + CARD_GAP + card.height <= vh - VIEWPORT_MARGIN) { chosen = candidate; break }
    if (candidate === 'top' && padded.top - CARD_GAP - card.height >= VIEWPORT_MARGIN) { chosen = candidate; break }
    if (candidate === 'right' && padded.right + CARD_GAP + card.width <= vw - VIEWPORT_MARGIN) { chosen = candidate; break }
    if (candidate === 'left' && padded.left - CARD_GAP - card.width >= VIEWPORT_MARGIN) { chosen = candidate; break }
  }

  const centerX = (padded.left + padded.right) / 2 - card.width / 2
  const centerY = (padded.top + padded.bottom) / 2 - card.height / 2
  let left: number
  let top: number
  if (chosen === 'bottom') { left = centerX; top = padded.bottom + CARD_GAP }
  else if (chosen === 'top') { left = centerX; top = padded.top - CARD_GAP - card.height }
  else if (chosen === 'right') { left = padded.right + CARD_GAP; top = centerY }
  else { left = padded.left - CARD_GAP - card.width; top = centerY }

  return {
    left: clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vw - card.width - VIEWPORT_MARGIN)),
    top: clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vh - card.height - VIEWPORT_MARGIN)),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 多个矩形的外接矩形（用于「视觉同一面板但 DOM 分散在多个容器」的锚点联合）；空数组返回 null */
export function unionRects(rects: AnchorRect[]): AnchorRect | null {
  if (rects.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.left + rect.width)
    bottom = Math.max(bottom, rect.top + rect.height)
  }
  return { left, top, width: right - left, height: bottom - top }
}
