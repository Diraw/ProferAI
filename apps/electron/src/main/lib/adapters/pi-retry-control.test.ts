import { describe, expect, test } from 'bun:test'
import * as provider from '@profer/agent-provider-pi/pi/retry-control'
import * as adapter from './pi-retry-control'

describe('pi-retry-control compatibility shim', () => {
  test('re-exports provider implementation without duplication', () => {
    expect(adapter.createPiRetryTerminalGate).toBe(provider.createPiRetryTerminalGate)
    expect(adapter.getPiNativeRetryOutcome).toBe(provider.getPiNativeRetryOutcome)
    expect(adapter.mapPiNativeRetryEvent).toBe(provider.mapPiNativeRetryEvent)
  })
})
