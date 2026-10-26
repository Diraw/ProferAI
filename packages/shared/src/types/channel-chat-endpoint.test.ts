import { describe, expect, test } from 'bun:test'
import {
  getChatUnavailableReason,
  hasChatEndpoint,
  isChannelEnabledForChat,
  type ChatEligibilityChannel,
} from './channel'

/** 自配渠道的最小 fixture：默认带 Chat 端点。 */
function selfConfigured(overrides: Partial<ChatEligibilityChannel> = {}): ChatEligibilityChannel {
  return {
    provider: 'anthropic',
    enabled: true,
    baseUrl: 'https://fixture.invalid',
    ...overrides,
  }
}

describe('Chat 端点资格：自配渠道必须有 Chat Base URL', () => {
  test('Given 只勾 Claude 的渠道 baseUrl 为空 When 判定 Chat 资格 Then 拒绝并给出未配置端点原因', () => {
    const channel = selfConfigured({ baseUrl: '' })
    expect(hasChatEndpoint(channel)).toBe(false)
    expect(getChatUnavailableReason(channel)).toBe('no-endpoint')
    expect(isChannelEnabledForChat(channel)).toBe(false)
  })

  test('Given baseUrl 只有空白字符 When 判定 Chat 资格 Then 同样视为未配置端点', () => {
    expect(isChannelEnabledForChat(selfConfigured({ baseUrl: '   ' }))).toBe(false)
  })

  test('Given 自配渠道填写了 Chat 端点 When 判定 Chat 资格 Then 允许', () => {
    const channel = selfConfigured({ baseUrl: 'https://gateway.invalid/v1' })
    expect(hasChatEndpoint(channel)).toBe(true)
    expect(getChatUnavailableReason(channel)).toBeNull()
    expect(isChannelEnabledForChat(channel)).toBe(true)
  })
})

describe('Chat 端点资格：官方代管渠道按真实路由豁免', () => {
  test('Given serverManaged 渠道 baseUrl 为空 When 判定 Chat 资格 Then 走 Relay 仍然允许', () => {
    const channel = selfConfigured({ provider: 'openai', baseUrl: '', serverManaged: true, id: 'fixture-managed' })
    expect(hasChatEndpoint(channel)).toBe(true)
    expect(isChannelEnabledForChat(channel)).toBe(true)
  })

  test('Given 历史 newapi- 渠道未声明 serverManaged 且 baseUrl 为空 When 判定 Chat 资格 Then 仍按代管渠道豁免', () => {
    const channel = selfConfigured({ provider: 'openai', baseUrl: '', id: 'newapi-legacy' })
    expect(isChannelEnabledForChat(channel)).toBe(true)
  })

  test('Given serverManaged 渠道直连数据面且 baseUrl 为空 When 判定 Chat 资格 Then 拒绝（绕开 Relay 没有可请求地址）', () => {
    const channel = selfConfigured({ provider: 'openai', baseUrl: '', serverManaged: true, directDataPlane: true, id: 'fixture-direct' })
    expect(hasChatEndpoint(channel)).toBe(false)
    expect(isChannelEnabledForChat(channel)).toBe(false)
  })

  test('Given serverManaged 渠道直连数据面且填写了 baseUrl When 判定 Chat 资格 Then 允许', () => {
    const channel = selfConfigured({ provider: 'openai', baseUrl: 'https://data.invalid/v1', serverManaged: true, directDataPlane: true })
    expect(isChannelEnabledForChat(channel)).toBe(true)
  })
})

describe('Chat 端点资格：原有拒绝原因保持不变', () => {
  test('Given 渠道已停用 When 判定 Chat 资格 Then 原因是 disabled', () => {
    const channel = selfConfigured({ enabled: false })
    expect(getChatUnavailableReason(channel)).toBe('disabled')
    expect(isChannelEnabledForChat(channel)).toBe(false)
  })

  test('Given Codex 订阅渠道 When 判定 Chat 资格 Then 原因是 subscription-only', () => {
    const channel = selfConfigured({ provider: 'openai-codex', baseUrl: '' })
    expect(getChatUnavailableReason(channel)).toBe('subscription-only')
    expect(isChannelEnabledForChat(channel)).toBe(false)
  })

  test('Given xAI OAuth 渠道 When 判定 Chat 资格 Then 原因是 subscription-only', () => {
    const channel = selfConfigured({ provider: 'xai', credentialMode: 'oauth', baseUrl: 'https://api.x.ai/v1' })
    expect(getChatUnavailableReason(channel)).toBe('subscription-only')
    expect(isChannelEnabledForChat(channel)).toBe(false)
  })

  test('Given xAI API Key 渠道 When 判定 Chat 资格 Then 允许', () => {
    const channel = selfConfigured({ provider: 'xai', credentialMode: 'api-key', baseUrl: 'https://api.x.ai/v1' })
    expect(getChatUnavailableReason(channel)).toBeNull()
    expect(isChannelEnabledForChat(channel)).toBe(true)
  })
})
