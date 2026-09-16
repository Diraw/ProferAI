import { describe, expect, test } from 'bun:test'
import { getAdapter } from './index.ts'

describe('provider adapter instances', () => {
  test('每次获取 Anthropic adapter 都是独立实例，避免流式 block 状态跨请求污染', () => {
    expect(getAdapter('anthropic')).not.toBe(getAdapter('anthropic'))
  })

  test('每次获取 Google adapter 都是独立实例，避免工具计数器跨请求污染', () => {
    expect(getAdapter('google')).not.toBe(getAdapter('google'))
  })
})
