import { describe, expect, test } from 'bun:test'
import {
  applyComposerToolbarPreferences,
  normalizeComposerToolbarPreferences,
  updateComposerToolbarSurfacePreferences,
} from './composer-toolbar-preferences'

describe('composer toolbar preferences', () => {
  test('normalizes missing entries without resetting core positions', () => {
    const preferences = normalizeComposerToolbarPreferences({
      chat: {
        model: { visible: false, order: 99 },
        attach: { visible: false, order: 4 },
        thinking: { visible: false, order: 0 },
      },
    })

    expect(preferences.chat?.model).toEqual({ visible: true, order: 99 })
    expect(preferences.chat?.attach).toEqual({ visible: true, order: 4 })
    expect(preferences.chat?.thinking).toEqual({ visible: false, order: 0 })
    expect(preferences.agent?.graph).toEqual({ visible: true, order: 7 })
  })

  test('applies user ordering to core tools while keeping them visible in the main row', () => {
    const items = [
      { key: 'model', node: 'model' },
      { key: 'attach', node: 'attach' },
      { key: 'thinking', node: 'thinking' },
      { key: 'tools', node: 'tools' },
    ]
    const result = applyComposerToolbarPreferences('chat', items, {
      chat: {
        model: { visible: false, order: 21 },
        attach: { visible: false, order: 20 },
        thinking: { visible: true, order: 3 },
        tools: { visible: false, order: 1 },
      },
    })

    expect(result.map((item) => item.key)).toEqual(['tools', 'thinking', 'attach', 'model'])
    expect(result[0]?.visible).toBe(false)
    expect(result[1]?.visible).toBe(true)
    for (const core of result.slice(2)) {
      expect(core.visible).toBe(true)
      expect(core.canOverflow).toBe(false)
    }
  })

  test.each(['chat', 'agent'] as const)('%s saves and restores core positions without allowing them to be hidden', (surface) => {
    const order = surface === 'chat'
      ? ['clear', 'attach', 'context', 'tools', 'model', 'thinking', 'speech']
      : ['graph', 'attach', 'runtime', 'permission-mode', 'model', 'preset', 'speech', 'context-usage']
    const current = normalizeComposerToolbarPreferences(undefined)
    const next = updateComposerToolbarSurfacePreferences(current, surface, order, new Set([order[0]!]))
    const restored = normalizeComposerToolbarPreferences(JSON.parse(JSON.stringify(next)))

    expect(restored[surface]?.attach).toEqual({ visible: true, order: 1 })
    expect(restored[surface]?.model).toEqual({ visible: true, order: 4 })
    expect(restored[surface]?.speech?.visible).toBe(false)
    const items = order.map((key) => ({ key }))
    expect(applyComposerToolbarPreferences(surface, items, restored).map((item) => item.key)).toEqual(order)
    expect(next[surface === 'chat' ? 'agent' : 'chat']).toEqual(current[surface === 'chat' ? 'agent' : 'chat'])
  })
})
