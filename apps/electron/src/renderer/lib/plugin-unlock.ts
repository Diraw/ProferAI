/** 版本号连击解锁插件入口的纯状态机。 */

export const PLUGIN_UNLOCK_CLICK_COUNT = 5
export const PLUGIN_UNLOCK_MAX_GAP_MS = 1_500

export interface PluginUnlockClickState {
  count: number
  lastClickedAt: number | null
}

export interface PluginUnlockClickResult {
  state: PluginUnlockClickState
  unlocked: boolean
}

export const INITIAL_PLUGIN_UNLOCK_CLICK_STATE: PluginUnlockClickState = {
  count: 0,
  lastClickedAt: null,
}

/**
 * 仅把时间间隔足够短的点击视为同一序列；达到阈值后重置，避免重复触发。
 */
export function advancePluginUnlockClick(
  state: PluginUnlockClickState,
  clickedAt: number,
): PluginUnlockClickResult {
  const continuesSequence = state.lastClickedAt !== null
    && clickedAt >= state.lastClickedAt
    && clickedAt - state.lastClickedAt <= PLUGIN_UNLOCK_MAX_GAP_MS
  const count = continuesSequence ? state.count + 1 : 1

  if (count >= PLUGIN_UNLOCK_CLICK_COUNT) {
    return {
      state: { count: 0, lastClickedAt: null },
      unlocked: true,
    }
  }

  return {
    state: { count, lastClickedAt: clickedAt },
    unlocked: false,
  }
}
