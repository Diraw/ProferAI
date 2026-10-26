import { describe, expect, test } from 'bun:test'
import { detectThinkingCapability } from './thinking-capability'

describe('Claude adaptive thinking capability', () => {
  test('Given Claude 5.x When detecting Then uses adaptive-only and omits disabled thinking', () => {
    expect(detectThinkingCapability('anthropic', 'claude-haiku-5-5')).toEqual({
      mode: 'adaptive-only',
      disableStrategy: 'omit-field',
    })
    expect(detectThinkingCapability('anthropic', 'claude-opus-5-5')).toEqual({
      mode: 'adaptive-only',
      disableStrategy: 'omit-field',
    })
    expect(detectThinkingCapability('anthropic', 'claude-sonnet-5')).toEqual({
      mode: 'adaptive-only',
      disableStrategy: 'omit-field',
    })
  })

  test('Given Claude 4.7/4.8 When detecting Then still uses adaptive-only', () => {
    expect(detectThinkingCapability('anthropic', 'claude-opus-4-7').mode).toBe('adaptive-only')
    expect(detectThinkingCapability('anthropic', 'claude-opus-4-8').mode).toBe('adaptive-only')
  })

  test('Given Claude 4.6 When detecting Then keeps adaptive-preferred', () => {
    expect(detectThinkingCapability('anthropic', 'claude-opus-4-6').mode).toBe('adaptive-preferred')
    expect(detectThinkingCapability('anthropic', 'claude-sonnet-4-6').mode).toBe('adaptive-preferred')
  })

  test('Given Claude 4.5 and older When detecting Then keeps the manual protocol', () => {
    expect(detectThinkingCapability('anthropic', 'claude-haiku-4-5').mode).toBe('manual-only')
    expect(detectThinkingCapability('anthropic', 'claude-3-7-sonnet').mode).toBe('manual-only')
  })
})
