import { describe, expect, test } from 'bun:test'
import { createAgentComposerToolbarItems } from './agent-composer-toolbar-config'

describe('Agent composer toolbar descriptor', () => {
  test('keeps the model as a fixed primary action and conditionally includes optional nodes', () => {
    const items = createAgentComposerToolbarItems({
      model: 'model',
      runtime: 'runtime',
      permissionMode: 'permission',
      preset: 'preset',
      thinking: 'thinking',
      attach: 'attach',
      contextUsage: 'usage',
    })
    expect(items.map((item) => item.key)).toEqual([
      'model',
      'attach',
      'runtime',
      'permission-mode',
      'preset',
      'thinking',
      'context-usage',
    ])
    expect(items[0]?.canOverflow).toBe(false)
  })
})
