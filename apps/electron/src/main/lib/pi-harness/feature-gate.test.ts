import { describe, expect, test } from 'bun:test'
import { PI_HARNESS_FEATURE_ENV, isPiHarnessEnabled, shouldStartPiHarness } from './feature-gate'

describe('Pi Host Harness feature gate', () => {
  test('fails closed when the environment flag is absent', () => {
    expect(isPiHarnessEnabled({})).toBe(false)
  })

  test('enables only for the explicit controlled opt-in value', () => {
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: '1' })).toBe(true)
    expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: ' 1 ' })).toBe(true)
  })

  test.each(['0', 'true', 'yes', '', '  ', '1.0'])(
    'fails closed for unsupported value %j',
    (value) => {
      expect(isPiHarnessEnabled({ [PI_HARNESS_FEATURE_ENV]: value })).toBe(false)
    },
  )

  test('does not enter Harness startup when the gate is closed', () => {
    let startCalls = 0
    const startIfEnabled = (runtime: 'pi' | 'claude', env: NodeJS.ProcessEnv): string | undefined => {
      if (!shouldStartPiHarness(runtime, env)) return undefined
      startCalls += 1
      return 'started'
    }

    expect(startIfEnabled('pi', {})).toBeUndefined()
    expect(startIfEnabled('claude', { [PI_HARNESS_FEATURE_ENV]: '1' })).toBeUndefined()
    expect(startCalls).toBe(0)
  })

  test('enters Harness startup only for Pi with explicit opt-in', () => {
    expect(shouldStartPiHarness('pi', { [PI_HARNESS_FEATURE_ENV]: '1' })).toBe(true)
    expect(shouldStartPiHarness('claude', { [PI_HARNESS_FEATURE_ENV]: '1' })).toBe(false)
  })
})
