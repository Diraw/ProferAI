/**
 * Composer 紧凑档（窗口高度驱动）纯逻辑
 *
 * 需求：窗口内高较低时，输入框仍按常规高度会明显挤占消息区，需要在矮窗口下把输入框
 * 整体压矮（默认 < 700px 时：空内容高度 101px → 60px、上限 200px → 140px）。
 * 阈值与两个高度都可在设置里调整，阈值 0 = 关闭。
 *
 * 历史：2026-09-13 曾移除过一版「窗口高度驱动紧凑档」，原因是拖拽窗口时输入框在阈值
 * 附近反复切换，高度每次变化约 40px，消息区/composer 边界跟着跳（单次拖拽实测 4 次）。
 * 本次重新引入时用两个手段消除抖动：
 * 1) 迟滞（hysteresis）：进入紧凑档用 threshold，退出需要高出 COMPACT_EXIT_HYSTERESIS_PX，
 *    避免窗口停在阈值附近时反复切换；
 * 2) 不给 max-height / min-height 加过渡动画：切换保持一次离散重排，不再被动画拉成连续 reflow。
 */

/** 默认触发阈值（窗口内高，px）。 */
export const DEFAULT_COMPACT_VIEWPORT_HEIGHT = 700

/** 默认紧凑档输入框上限（px）。 */
export const DEFAULT_COMPACT_MAX_HEIGHT = 140

/** 退出紧凑档所需的额外高度余量（px）。 */
export const COMPACT_EXIT_HYSTERESIS_PX = 60

/** 输入框三档基准高度（px），与 rich-text-input 既有视觉保持一致。 */
export const COMPOSER_TIER_HEIGHTS = {
  collapsed: 101,
  default: 200,
  expanded: 500,
} as const

/**
 * 编辑器（ProseMirror）常规最小高度（px）。
 * 输入框空内容时的可见高度就由它决定，所以「是否真的变矮」看的是这个值。
 */
export const COMPOSER_EDITOR_MIN_HEIGHT = 101

/** 紧凑档默认最小高度（px）：矮窗口下输入框整体变矮约 40px 的关键。 */
export const DEFAULT_COMPACT_MIN_HEIGHT = 60

/** 紧凑档最小高度的可配置范围（px）：上限不超过常规最小高度，否则不会变矮。 */
export const COMPACT_MIN_HEIGHT_RANGE = { min: 40, max: COMPOSER_EDITOR_MIN_HEIGHT } as const

/** 触发窗口高度的可配置范围（px）。 */
export const COMPACT_VIEWPORT_HEIGHT_RANGE = { min: 400, max: 1600 } as const

/** 紧凑档上限的可配置范围（px）：上限不超过常规默认档，否则就不叫紧凑档了。 */
export const COMPACT_MAX_HEIGHT_RANGE = { min: 80, max: COMPOSER_TIER_HEIGHTS.default } as const

/**
 * 归一化「触发窗口高度」。
 * - `0` 是合法值，表示关闭该行为
 * - 非法/缺省值回退默认 700
 * - 其余值收敛到可配置范围
 */
export function normalizeCompactViewportHeight(value: unknown): number {
  if (value === 0) return 0
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_COMPACT_VIEWPORT_HEIGHT
  return Math.min(
    COMPACT_VIEWPORT_HEIGHT_RANGE.max,
    Math.max(COMPACT_VIEWPORT_HEIGHT_RANGE.min, Math.round(num))
  )
}

/** 归一化「紧凑档输入框上限」。 */
export function normalizeCompactMaxHeight(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_COMPACT_MAX_HEIGHT
  return Math.min(
    COMPACT_MAX_HEIGHT_RANGE.max,
    Math.max(COMPACT_MAX_HEIGHT_RANGE.min, Math.round(num))
  )
}

/** 归一化「紧凑档输入框最小高度」（决定空内容时矮多少）。 */
export function normalizeCompactMinHeight(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_COMPACT_MIN_HEIGHT
  return Math.min(
    COMPACT_MIN_HEIGHT_RANGE.max,
    Math.max(COMPACT_MIN_HEIGHT_RANGE.min, Math.round(num))
  )
}

/**
 * 按迟滞规则判定当前是否处于紧凑档。
 * - 未处于紧凑档：窗口高度 < threshold 才进入
 * - 已处于紧凑档：窗口高度 < threshold + 余量 才保持，否则退出
 * - threshold <= 0：关闭，恒为 false
 */
export function resolveCompactViewport(
  previous: boolean,
  viewportHeight: number,
  threshold: number
): boolean {
  if (!Number.isFinite(threshold) || threshold <= 0) return false
  if (!Number.isFinite(viewportHeight)) return previous
  return previous
    ? viewportHeight < threshold + COMPACT_EXIT_HYSTERESIS_PX
    : viewportHeight < threshold
}

/**
 * 计算输入框当前应使用的 max-height（px）。
 * - 手动折叠档优先（101px），与窗口高度无关
 * - 非紧凑档：展开 500px / 默认 200px
 * - 紧凑档：默认档压到配置上限（默认 140px）；展开档取该上限的 2 倍且不超过常规展开档
 */
export function resolveComposerMaxHeight(input: {
  manuallyCollapsed: boolean
  expanded: boolean
  compact: boolean
  compactMaxHeight: number
}): number {
  if (input.manuallyCollapsed) return COMPOSER_TIER_HEIGHTS.collapsed
  if (!input.compact) {
    return input.expanded ? COMPOSER_TIER_HEIGHTS.expanded : COMPOSER_TIER_HEIGHTS.default
  }
  const compactDefault = Math.min(
    COMPOSER_TIER_HEIGHTS.default,
    normalizeCompactMaxHeight(input.compactMaxHeight)
  )
  return input.expanded
    ? Math.min(COMPOSER_TIER_HEIGHTS.expanded, compactDefault * 2)
    : compactDefault
}

/**
 * 计算编辑器（ProseMirror）的 min-height（px）。
 *
 * 输入框空内容时的可见高度 = 这个值，所以「窗口矮就降低输入框高度」的可见效果靠它：
 * 常规 101px（可容纳占位文字 + 折叠按钮），紧凑档降到配置值（默认 60px）。
 */
export function resolveComposerMinHeight(input: {
  compact: boolean
  compactMinHeight: number
}): number {
  if (!input.compact) return COMPOSER_EDITOR_MIN_HEIGHT
  return Math.min(
    COMPOSER_EDITOR_MIN_HEIGHT,
    normalizeCompactMinHeight(input.compactMinHeight)
  )
}
