/**
 * navigation-item-key — 导航条目在「迷你地图面板」与「导航索引组装」之间的统一唯一键。
 *
 * 两处（面板列表渲染 / 索引去重）必须用同一个键，否则会出现「同一条被当成两条」或
 * 「本地已加载的条目与索引对不上」。所以抽成一个无依赖的小函数，避免两处各抄一份。
 */

/** 导航条目身份的最小结构（ScrollMinimap 的 MinimapItem 与 navigation-items 的 NavigationItem 都满足）。 */
export interface NavigationKeyedItem {
  /** 滚动锚点 id（消息 uuid）；无 uuid 时为 null，需用 matchKey 回退匹配 */
  id: string | null
  /** 无 id 时的稳定匹配键（`${role}:${subtype}:${createdAt}`） */
  matchKey?: string
}

/** 导航条目的唯一键：有 uuid 用 uuid，无 uuid 用匹配键。 */
export function navigationItemKey(item: NavigationKeyedItem): string {
  return item.id ?? `key:${item.matchKey ?? ''}`
}
