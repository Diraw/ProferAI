import { describe, expect, test } from 'bun:test'
import { normalizeChatStreamError } from './chat-error-utils'

describe('normalizeChatStreamError', () => {
  test('xAI 503 使用稳定的服务不可用提示，不泄露上游 JSON', () => {
    const result = normalizeChatStreamError(
      'xai',
      new Error('xai API 错误 (503): {"error":{"message":"Service temporarily unavailable","type":"server_error"}}'),
    )

    expect(result).toEqual({
      message: 'xAI 服务暂时不可用（503），系统已自动重试，请稍后再试。',
      code: 'upstream_unavailable',
      errorTitle: '服务暂时不可用',
    })
  })

  test('429 映射为限流提示', () => {
    expect(normalizeChatStreamError('openai', 'openai API 错误 (429): too many requests')).toEqual({
      message: '上游模型服务请求过于频繁（429），系统已自动重试，请稍后再试。',
      code: 'rate_limited',
      errorTitle: '请求过于频繁',
    })
  })

  test('非瞬时错误保留原始文案', () => {
    expect(normalizeChatStreamError('xai', new Error('xai API 错误 (401): invalid api key'))).toEqual({
      message: 'xai API 错误 (401): invalid api key',
    })
  })

  test('custom 渠道 404 换成可操作的端点定位提示', () => {
    expect(normalizeChatStreamError('custom', new Error('custom API 错误 (404): 404 page not found'))).toEqual({
      message: '请求地址未匹配到上游接口（404）：OpenAI 兼容格式渠道的地址需指向 /chat/completions（例如 https://host/v1/chat/completions），同时确认模型 ID 在该渠道可用。',
      errorTitle: '请求地址可能不正确',
    })
  })

  test('内置渠道 404 保留原始文案（地址由 adapter 拼装，404 另有成因）', () => {
    expect(normalizeChatStreamError('openai', new Error('openai API 错误 (404): model not found'))).toEqual({
      message: 'openai API 错误 (404): model not found',
    })
  })
})
