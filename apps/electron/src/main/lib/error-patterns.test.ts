import { expect, test } from 'bun:test'
import * as legacy from './error-patterns'
import * as runtime from '@profer/agent-runtime/error-patterns'

test('Given an existing import When loading the compatibility entry Then it shares the runtime implementation', () => {
  expect(legacy).toEqual(runtime)
})
