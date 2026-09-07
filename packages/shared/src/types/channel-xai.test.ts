import { describe, expect, test } from 'bun:test'
import {
  isAgentEnabledForChannel,
  resolveXaiCredentialMode,
} from './channel'

const oauthSecret = JSON.stringify({
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
})

function channel(overrides: Partial<{
  provider: 'xai' | 'anthropic'
  enabled: boolean
  agentExperimentalEnabled: boolean
}> = {}) {
  return {
    provider: 'xai' as const,
    enabled: true,
    ...overrides,
  }
}

describe('xAI 凭据模式与 Agent 实验开关', () => {
  test('Given 历史 xAI OAuth JSON When 未声明模式 Then 自动识别为 oauth', () => {
    expect(resolveXaiCredentialMode(undefined, oauthSecret)).toBe('oauth')
  })

  test('Given 普通 xAI API Key When 未声明模式 Then 自动识别为 api-key', () => {
    expect(resolveXaiCredentialMode(undefined, 'xai-api-key')).toBe('api-key')
  })

  test('Given 明确模式与密文内容冲突 When 解析模式 Then OAuth 结构优先保护 refresh token', () => {
    expect(resolveXaiCredentialMode('api-key', oauthSecret)).toBe('oauth')
    expect(resolveXaiCredentialMode('oauth', 'xai-api-key')).toBe('oauth')
  })

  test('Given xAI 渠道未开启实验开关 When 判断 Agent 资格 Then 拒绝进入 Agent 列表', () => {
    expect(isAgentEnabledForChannel(channel())).toBe(false)
  })

  test('Given xAI 渠道已开启实验开关 When 判断 Agent 资格 Then 允许进入 Agent 列表', () => {
    expect(isAgentEnabledForChannel(channel({ agentExperimentalEnabled: true }))).toBe(true)
  })

  test('Given 非 xAI 的既有兼容渠道 When 判断 Agent 资格 Then 保持原有兼容语义', () => {
    expect(isAgentEnabledForChannel(channel({ provider: 'anthropic' }))).toBe(true)
  })
})
