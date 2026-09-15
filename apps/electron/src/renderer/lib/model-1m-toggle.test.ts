import { describe, expect, test } from 'bun:test'
import { resolveModel1MToggleState } from './model-1m-toggle'

describe('渠道模型 1M 勾选状态', () => {
  test('Given DeepSeek 官方 V4 模型且未手动设置 When 解析 Then 显示自动开启且点击会强关', () => {
    const state = resolveModel1MToggleState({ id: 'deepseek-v4-pro' }, 'deepseek')

    expect(state.enabled).toBe(true)
    expect(state.source).toBe('auto')
    expect(state.nextExplicit).toBe(false)
    expect(state.title).toContain('自动')
  })

  test('Given 未验证的第三方网关模型 When 解析 Then 默认不开启且点击会强开', () => {
    const state = resolveModel1MToggleState({ id: 'deepseek-v4-pro' }, 'custom')

    expect(state.enabled).toBe(false)
    expect(state.source).toBe('auto')
    expect(state.nextExplicit).toBe(true)
  })

  test('Given 用户在未验证网关上强开 When 解析 Then 显示已开启且点击会改为强关', () => {
    const state = resolveModel1MToggleState({ id: 'glm-4.6', context1m: true }, 'custom')

    expect(state.enabled).toBe(true)
    expect(state.source).toBe('forced-on')
    expect(state.nextExplicit).toBe(false)
    expect(state.title).toContain('手动开启')
  })

  test('Given 用户关掉了已验证模型的 1M When 解析 Then 显示关闭且来源为强关', () => {
    const state = resolveModel1MToggleState({ id: 'deepseek-v4-pro', context1m: false }, 'deepseek')

    expect(state.enabled).toBe(false)
    expect(state.source).toBe('forced-off')
    expect(state.nextExplicit).toBe(true)
    expect(state.title).toContain('手动关闭')
  })
})
