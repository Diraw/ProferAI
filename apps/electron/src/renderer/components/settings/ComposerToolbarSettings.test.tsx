import { expect, mock, test } from 'bun:test'
import * as React from 'react'
import { atom, createStore } from 'jotai/vanilla'
import { createLoadedHost } from '../../../../scripts/settings-loaded-visual-host'
import { normalizeComposerToolbarPreferences } from '../../lib/composer-toolbar-preferences'
import type { AppSettings } from '../../../types'

// 沿用设置页隔离 hook 宿主，执行真实按钮/拖拽回调；不冒充真实 DOM 验收。
const store = createStore()
type WritableTarget = Parameters<typeof store.set>[0]
const setters = new Map<WritableTarget, (value: unknown) => void>()
mock.module('jotai', () => ({
  atom,
  useAtom: (target: WritableTarget) => {
    let setter = setters.get(target)
    if (!setter) {
      setter = (value: unknown) => { store.set(target, value) }
      setters.set(target, setter)
    }
    return [store.get(target), setter]
  },
}))
mock.module('sonner', () => ({ toast: { success() {}, error() {} } }))
const { ComposerToolbarSettings } = await import('./ComposerToolbarSettings')
const { composerToolbarPreferencesAtom } = await import('../../atoms/composer-toolbar-preferences')

test.each(['chat', 'agent'] as const)('%s 核心工具可按钮排序和拖拽，显示开关仍锁定', async (surface) => {
  store.set(composerToolbarPreferencesAtom, normalizeComposerToolbarPreferences(undefined))
  const writes: Partial<AppSettings>[] = []
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { updateSettings: async (patch: Partial<AppSettings>) => { writes.push(patch); return patch } } },
  })
  const host = createLoadedHost(() => <ComposerToolbarSettings />, new Set(['ComposerToolbarSettings']))
  try {
    await host.settle()
    if (surface === 'agent') await host.click('Agent')
    const control = (label: string) => host.elements().find((element) => element.props['aria-label'] === label)!.props
    expect(control('模型显示').disabled).toBe(true)
    expect(control('附件显示').disabled).toBe(true)
    expect(control('下移模型').disabled).toBe(false)
    expect(control('上移附件').disabled).toBe(false)
    await host.click('下移模型')
    expect(store.get(composerToolbarPreferencesAtom)[surface]?.model?.order).toBe(1)
    expect(store.get(composerToolbarPreferencesAtom)[surface]?.attach?.order).toBe(0)

    const rows = () => host.elements().filter((element) => element.props.role === 'listitem')
    expect(rows().every((row) => row.props.draggable === true)).toBe(true)
    const source = rows()[0]!
    ;(source.props.onDragStart as () => void)()
    await host.settle()
    const lastIndex = rows().length - 1
    ;(rows()[lastIndex]!.props.onDrop as () => void)()
    await host.settle()
    const preferences = store.get(composerToolbarPreferencesAtom)[surface]!
    expect(preferences.attach).toEqual({ visible: true, order: lastIndex })
    expect(preferences.model).toEqual({ visible: true, order: 0 })
    expect(writes.at(-1)?.composerToolbarPreferences?.[surface]?.attach).toEqual(preferences.attach)
  } finally {
    host.dispose()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
