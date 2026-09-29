import { expect, test } from 'bun:test'
import { isMacFunctionKeyEvent, resolveShortcutDispatch } from './shortcut-registry'

/** macOS 数字行上的整套功能键 */
const ALL_FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`)

const keyEvent = (key: string, isComposing = false): {
  key: string
  code: string
  isComposing: boolean
} => ({ key, code: key, isComposing })

// ===== 功能键识别 =====

test('识别 macOS 的 F1–F12 功能键', () => {
  expect(isMacFunctionKeyEvent({ key: 'F1', code: 'F1' }, true)).toBe(true)
  expect(isMacFunctionKeyEvent({ key: 'Unidentified', code: 'F12' }, true)).toBe(true)
})

test('不把普通键、F13 或非 macOS 按键当成功能键', () => {
  expect(isMacFunctionKeyEvent({ key: 'a', code: 'KeyA' }, true)).toBe(false)
  expect(isMacFunctionKeyEvent({ key: 'F13', code: 'F13' }, true)).toBe(false)
  expect(isMacFunctionKeyEvent({ key: 'F1', code: 'F1' }, false)).toBe(false)
})

// ===== 分发决策 =====
//
// 功能键的拦截不在主进程按白名单做，全部收敛到 resolveShortcutDispatch，
// 因此这里覆盖的即是「整套功能键交给渲染层」这一策略的全部边界。

test('Given macOS 且未绑定任何功能键 When 按下整套 F1–F12 Then 一律阻止默认行为', () => {
  for (const key of ALL_FUNCTION_KEYS) {
    expect(resolveShortcutDispatch(keyEvent(key), 'none', true)).toEqual({
      runHandlers: false,
      swallow: true,
    })
  }
})

test('Given macOS 且用户改绑到其它功能键 When 按下该键 Then 正常分发并阻止默认行为', () => {
  for (const key of ['F3', 'F7', 'F12']) {
    expect(resolveShortcutDispatch(keyEvent(key), 'handled', true)).toEqual({
      runHandlers: true,
      swallow: true,
    })
  }
})

test('Given macOS 且命中定义但当前无 handler When 按下功能键 Then 不执行但仍阻止默认行为', () => {
  for (const key of ['F1', 'F2']) {
    expect(resolveShortcutDispatch(keyEvent(key), 'no-handler', true)).toEqual({
      runHandlers: false,
      swallow: true,
    })
  }
})

test('Given macOS When 按下未绑定的普通键 Then 不干预', () => {
  expect(resolveShortcutDispatch(keyEvent('k'), 'none', true)).toEqual({
    runHandlers: false,
    swallow: false,
  })
})

test('Given Windows When 按下未绑定的功能键或普通键 Then 不阻止默认行为', () => {
  expect(resolveShortcutDispatch(keyEvent('F3'), 'none', false)).toEqual({
    runHandlers: false,
    swallow: false,
  })
  expect(resolveShortcutDispatch(keyEvent('k'), 'none', false)).toEqual({
    runHandlers: false,
    swallow: false,
  })
})

test('Given Windows 且命中 handler When 按下对应按键 Then 照常执行并阻止默认行为', () => {
  expect(resolveShortcutDispatch(keyEvent('F3'), 'handled', false)).toEqual({
    runHandlers: true,
    swallow: true,
  })
})

test('Given 输入法组合中 When 命中快捷键 Then 不执行 handler 也不吞掉普通键', () => {
  expect(resolveShortcutDispatch(keyEvent('k', true), 'handled', true)).toEqual({
    runHandlers: false,
    swallow: false,
  })
})

test('Given 输入法组合中 When 按下 macOS 功能键 Then 仍阻止默认行为，避免漏出焦点框', () => {
  for (const key of ['F1', 'F5', 'F12']) {
    expect(resolveShortcutDispatch(keyEvent(key, true), 'none', true)).toEqual({
      runHandlers: false,
      swallow: true,
    })
  }
})
