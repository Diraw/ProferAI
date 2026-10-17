import { expect, test } from 'bun:test'
import { RuntimeRoutingAgentAdapter as legacy } from './runtime-routing-agent-adapter'
import { RuntimeRoutingAgentAdapter as runtime } from '@profer/agent-runtime/runtime-routing-adapter'

test('Given the legacy routing entry When imported Then it uses the runtime implementation', () => {
  expect(legacy).toBe(runtime)
})
