import { expect, test } from 'bun:test'
import * as legacy from './pi-message-adapter'
import * as provider from '@profer/agent-provider-pi/pi/message-adapter'

test('Given an existing import When loading the compatibility entry Then it shares the provider implementation', () => {
  expect(legacy).toEqual(provider)
})
