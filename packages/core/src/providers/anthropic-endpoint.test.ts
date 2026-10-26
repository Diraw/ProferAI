import { expect, test } from 'bun:test'
import { AnthropicAdapter } from './anthropic-adapter'

test('Anthropic 流式与标题请求统一完整端点并保留 query/hash', () => {
  const adapter = new AnthropicAdapter('anthropic')
  const input = { baseUrl: 'https://fixture.invalid/v1/messages?route=fixture#anchor', apiKey: 'fixture-key', modelId: 'fixture-model' }
  const stream = adapter.buildStreamRequest({ ...input, userMessage: 'fixture', history: [], readImageAttachments: () => [] })
  const title = adapter.buildTitleRequest({ ...input, prompt: 'fixture' })
  expect(stream.url).toBe(input.baseUrl)
  expect(title.url).toBe(input.baseUrl)
  expect(stream.headers['x-api-key']).toBe(input.apiKey)
})

test('Anthropic 根地址只在 pathname 添加 messages，不插到 query 后', () => {
  const adapter = new AnthropicAdapter('anthropic')
  const title = adapter.buildTitleRequest({ baseUrl: 'https://fixture.invalid?route=fixture', apiKey: 'fixture-key', modelId: 'fixture-model', prompt: 'fixture' })
  expect(title.url).toBe('https://fixture.invalid/v1/messages?route=fixture')
})

test('P0-3：Chat 与 Claude/Pi 共用推导，/anthropic 协议根补全 /v1/messages', () => {
  // 修复前 Chat 会请求 /anthropic/messages（不存在的端点），而 Agent 请求 /anthropic/v1/messages。
  const adapter = new AnthropicAdapter('anthropic')
  const baseUrl = 'https://fixture.invalid/anthropic'
  const stream = adapter.buildStreamRequest({ baseUrl, apiKey: 'fixture-key', modelId: 'fixture-model', userMessage: 'fixture', history: [], readImageAttachments: () => [] })
  const title = adapter.buildTitleRequest({ baseUrl, apiKey: 'fixture-key', modelId: 'fixture-model', prompt: 'fixture' })
  expect(stream.url).toBe('https://fixture.invalid/anthropic/v1/messages')
  expect(title.url).toBe('https://fixture.invalid/anthropic/v1/messages')
})

test('P0-3：anthropic-compatible 协议根不再原样当请求端点', () => {
  const adapter = new AnthropicAdapter('anthropic-compatible')
  const title = adapter.buildTitleRequest({ baseUrl: 'https://fixture.invalid/anthropic', apiKey: 'fixture-key', modelId: 'fixture-model', prompt: 'fixture' })
  expect(title.url).toBe('https://fixture.invalid/anthropic/v1/messages')
})

test('Anthropic 标题请求使用小预算并关闭思考', () => {
  const adapter = new AnthropicAdapter('anthropic')
  const title = adapter.buildTitleRequest({ baseUrl: 'https://fixture.invalid/v1/messages', apiKey: 'fixture-key', modelId: 'claude-sonnet-4-6', prompt: 'fixture' })
  expect(JSON.parse(title.body)).toMatchObject({
    max_tokens: 128,
    thinking: { type: 'disabled' },
  })
})

test('P2-10：adaptive 思考同时补 output_config.effort=high', () => {
  // Claude 5.x 的 400 提示要求「thinking.type=adaptive + output_config.effort」成对出现；
  // Chat 没有档位输入，取 adaptive 档案默认档 high。
  const adapter = new AnthropicAdapter('anthropic')
  for (const modelId of ['claude-haiku-5-5', 'claude-opus-4-6']) {
    const stream = adapter.buildStreamRequest({
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fixture-key',
      modelId,
      thinkingEnabled: true,
      userMessage: 'fixture',
      history: [],
      readImageAttachments: () => [],
    })
    expect(JSON.parse(stream.body)).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    })
  }
})

test('P2-10：关闭思考或 DeepSeek effort-based 分支不受 adaptive effort 影响', () => {
  const adapter = new AnthropicAdapter('anthropic')
  const build = (modelId: string, thinkingEnabled: boolean) => JSON.parse(adapter.buildStreamRequest({
    baseUrl: 'https://fixture.invalid',
    apiKey: 'fixture-key',
    modelId,
    thinkingEnabled,
    userMessage: 'fixture',
    history: [],
    readImageAttachments: () => [],
  }).body) as { thinking?: unknown; output_config?: unknown }

  // adaptive 模型关闭思考：沿用 omit-field，不发 thinking 也不发 effort。
  expect(build('claude-haiku-5-5', false).thinking).toBeUndefined()
  expect(build('claude-haiku-5-5', false).output_config).toBeUndefined()
  // DeepSeek v4 仍由 effort-based-max 分支发 max，不能被 high 覆盖。
  expect(build('deepseek-v4-pro', true)).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'max' } })
})
