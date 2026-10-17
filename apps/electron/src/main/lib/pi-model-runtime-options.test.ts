import { expect, test } from 'bun:test'
import * as legacy from './pi-model-runtime-options'
import * as provider from '@profer/agent-provider-pi/pi/model-runtime-options'

test('Given an existing import When loading the compatibility entry Then it shares the provider implementation', () => {
  // 类实例带私有字段，跨包比较用导出标识与工厂函数身份，避免依赖结构类型。
  expect(legacy.createIsolatedModelRuntimeOptions).toBe(provider.createIsolatedModelRuntimeOptions)
  expect(legacy.IsolatedInMemoryCredentialStore).toBe(provider.IsolatedInMemoryCredentialStore)
  expect(legacy).toEqual(provider)
})
