import { describe, expect, test } from 'bun:test'
import { resolveComposerToolbarLayout, type ComposerToolbarItem } from './ComposerToolbar'

const item = (key: string, width: number, canOverflow = true): ComposerToolbarItem & { width: number } => ({ key, width, canOverflow })

describe('ComposerToolbar layout policy', () => {
  test('keeps all items when the measured row fits', () => {
    const items = [item('model', 80), item('attach', 36)]
    const result = resolveComposerToolbarLayout({ items, widths: { model: 80, attach: 36 }, containerWidth: 130 })
    expect(result.visible.map((entry) => entry.key)).toEqual(['model', 'attach'])
    expect(result.overflow).toEqual([])
  })

  test('folds optional items from the right while preserving order', () => {
    const items = [item('model', 80, false), item('thinking', 36), item('attach', 36), item('tools', 36)]
    const result = resolveComposerToolbarLayout({
      items,
      widths: { model: 80, thinking: 36, attach: 36, tools: 36 },
      containerWidth: 130,
    })
    expect(result.visible.map((entry) => entry.key)).toEqual(['model'])
    expect(result.overflow.map((entry) => entry.key)).toEqual(['thinking', 'attach', 'tools'])
  })

  test('keeps fixed items visible even when they appear after optional items', () => {
    const items = [item('optional', 36), item('send-context', 80, false)]
    const result = resolveComposerToolbarLayout({
      items,
      widths: { optional: 36, 'send-context': 80 },
      containerWidth: 90,
    })
    expect(result.visible.map((entry) => entry.key)).toEqual(['send-context'])
    expect(result.overflow.map((entry) => entry.key)).toEqual(['optional'])
  })
})
