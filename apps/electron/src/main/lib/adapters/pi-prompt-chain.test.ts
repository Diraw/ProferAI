import { expect, test } from 'bun:test'
import * as legacy from './pi-prompt-chain'
import * as provider from '@profer/agent-provider-pi/pi/prompt-chain'

test('Given a legacy entry When importing Then the provider implementation is reused', () => {
  expect(legacy).toEqual(provider)
})
