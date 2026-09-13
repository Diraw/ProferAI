import { describe, expect, test } from 'bun:test'
import {
  INITIAL_PLUGIN_UNLOCK_CLICK_STATE,
  PLUGIN_UNLOCK_MAX_GAP_MS,
  advancePluginUnlockClick,
} from './plugin-unlock'

describe('advancePluginUnlockClick 插件入口解锁', () => {
  test('Given 版本号连续点击五次 When 每次间隔未超时 Then 仅第五次解锁', () => {
    let state = INITIAL_PLUGIN_UNLOCK_CLICK_STATE

    for (let click = 1; click <= 5; click += 1) {
      const result = advancePluginUnlockClick(state, click * 100)
      expect(result.unlocked).toBe(click === 5)
      state = result.state
    }

    expect(state).toEqual(INITIAL_PLUGIN_UNLOCK_CLICK_STATE)
  })

  test('Given 点击序列中断 When 下一次点击超过最大间隔 Then 从第一次重新计数', () => {
    const first = advancePluginUnlockClick(INITIAL_PLUGIN_UNLOCK_CLICK_STATE, 100)
    const second = advancePluginUnlockClick(first.state, 200)
    const restarted = advancePluginUnlockClick(second.state, 200 + PLUGIN_UNLOCK_MAX_GAP_MS + 1)

    expect(restarted.unlocked).toBe(false)
    expect(restarted.state.count).toBe(1)
  })

  test('Given 系统时间回拨 When 再次点击 Then 不沿用旧序列', () => {
    const first = advancePluginUnlockClick(INITIAL_PLUGIN_UNLOCK_CLICK_STATE, 1_000)
    const restarted = advancePluginUnlockClick(first.state, 900)

    expect(restarted.unlocked).toBe(false)
    expect(restarted.state).toEqual({ count: 1, lastClickedAt: 900 })
  })
})
