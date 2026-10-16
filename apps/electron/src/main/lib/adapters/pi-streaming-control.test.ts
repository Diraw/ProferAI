import { describe, expect, test } from 'bun:test'
import * as provider from '@profer/agent-provider-pi/pi/streaming-control'
import * as adapter from './pi-streaming-control'

describe('pi-streaming-control compatibility shim', () => {
  test('re-exports provider implementation without duplication', () => {
    expect(adapter.createPartialMessageCoalescer).toBe(provider.createPartialMessageCoalescer)
  })
})
