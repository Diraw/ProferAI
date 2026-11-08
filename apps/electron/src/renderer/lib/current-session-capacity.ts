/**
 * 「当前会话」区容量：档位归一化与高度夹算
 *
 * 需求：默认只显示约 5 个会话，用户希望能同时看到更多；但侧栏纵向高度是零和的，
 * 当前会话区变高就会挤占下方项目/会话列表。因此「最多显示 N 个」是**上限**而非
 * 目标高度，最终高度由浏览器取三者最小值：内容自然高度、N 行、视口剩余空间。
 *
 * 这里只产出纯常量与纯函数，不依赖 React / Jotai / DOM，便于 BDD 直接钉住边界。
 */

/** 会话行 28px + 列表 gap 1px，与 sidebarRowClass 的默认行高保持一致 */
export const CURRENT_SESSION_ROW_HEIGHT_PX = 29

/** 设置页档位；只放行白名单值，避免写入极大数字把下方项目区挤没 */
export const CURRENT_SESSION_VISIBLE_COUNT_OPTIONS = [3, 5, 8, 12, 20] as const

/** 默认值 12：开箱即可同时看到约 12 个会话，不必先进设置页调整 */
export const DEFAULT_CURRENT_SESSION_VISIBLE_COUNT = 12

/**
 * 高度夹算时预留的视口高度：顶部固定操作区约 100px + 当前会话标题 26px +
 * 下方主区 min-height 保底 160px，加少量余量取 290px，保证临界窗口也不溢出。
 *
 * 用 vh 而不是百分比：当前会话区外层是 flex-none、高度由内容决定，
 * 百分比 max-height 在这种包含块上无法解析，会退化成不限制。
 */
export const CURRENT_SESSION_RESERVED_VIEWPORT_PX = 290

/** 极矮窗口下的硬下限（约 4 行），避免 calc 结果为负导致 max-height 失效 */
export const CURRENT_SESSION_MIN_MAX_HEIGHT_PX = 4 * CURRENT_SESSION_ROW_HEIGHT_PX

/** 归一化持久化值：非法/缺省一律回落到默认档位 */
export function normalizeCurrentSessionVisibleCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_CURRENT_SESSION_VISIBLE_COUNT
  return (CURRENT_SESSION_VISIBLE_COUNT_OPTIONS as readonly number[]).includes(value)
    ? value
    : DEFAULT_CURRENT_SESSION_VISIBLE_COUNT
}

/**
 * 生成 max-height 表达式：
 *   min(N 行, max(硬下限, 视口剩余空间))
 *
 * 内容自然高度由 max-height + 内容自适应自动取小，无需写进表达式。
 * 调用方仍需保留 overflow-y-auto，并给下方主区设 min-height 作为双保险。
 */
export function buildCurrentSessionMaxHeight(count: number): string {
  const rows = normalizeCurrentSessionVisibleCount(count)
  return `min(calc(${rows} * ${CURRENT_SESSION_ROW_HEIGHT_PX}px), max(${CURRENT_SESSION_MIN_MAX_HEIGHT_PX}px, calc(100vh - ${CURRENT_SESSION_RESERVED_VIEWPORT_PX}px)))`
}

/** 设置页提示：当前窗口高度下实际约能看到几行（与夹算公式同源） */
export function resolveEffectiveVisibleRows(count: number, viewportHeight: number): number {
  const rows = normalizeCurrentSessionVisibleCount(count)
  const available = Number.isFinite(viewportHeight)
    ? Math.max(CURRENT_SESSION_MIN_MAX_HEIGHT_PX, viewportHeight - CURRENT_SESSION_RESERVED_VIEWPORT_PX)
    : CURRENT_SESSION_MIN_MAX_HEIGHT_PX
  return Math.max(1, Math.min(rows, Math.floor(available / CURRENT_SESSION_ROW_HEIGHT_PX)))
}
