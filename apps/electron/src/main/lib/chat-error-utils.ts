/** Chat 流式错误归一化，避免把上游原始 JSON 直接展示给用户。 */

export type ChatStreamErrorCode =
  | 'upstream_unavailable'
  | 'rate_limited'
  | 'request_timeout'

export interface ChatStreamErrorInfo {
  message: string
  code?: ChatStreamErrorCode
  errorTitle?: string
}

function extractHttpStatus(message: string): number | null {
  const match = message.match(/(?:API\s*(?:错误|Error)|HTTP(?:\s*status)?)\s*\(?\s*(\d{3})\s*\)?/i)
  if (!match) return null
  const status = Number(match[1])
  return Number.isInteger(status) ? status : null
}

/** 将 Chat 上游瞬时 HTTP 错误转成稳定、可读的 UI 文案。 */
export function normalizeChatStreamError(provider: string, error: unknown): ChatStreamErrorInfo {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const providerName = provider.toLowerCase() === 'xai' ? 'xAI' : '上游模型服务'
  const status = extractHttpStatus(rawMessage)

  if (status === 429) {
    return {
      message: `${providerName}请求过于频繁（429），系统已自动重试，请稍后再试。`,
      code: 'rate_limited',
      errorTitle: '请求过于频繁',
    }
  }

  if (status === 408 || status === 425) {
    return {
      message: `${providerName} 暂时未能响应（${status}），系统已自动重试，请稍后再试。`,
      code: 'request_timeout',
      errorTitle: '请求暂时未响应',
    }
  }

  if (status !== null && status >= 500) {
    return {
      message: `${providerName} 服务暂时不可用（${status}），系统已自动重试，请稍后再试。`,
      code: 'upstream_unavailable',
      errorTitle: '服务暂时不可用',
    }
  }

  if (/service\s+temporarily\s+unavailable|temporarily\s+unavailable|服务暂时不可用|服务繁忙/i.test(rawMessage)) {
    return {
      message: `${providerName} 服务暂时不可用，系统已自动重试，请稍后再试。`,
      code: 'upstream_unavailable',
      errorTitle: '服务暂时不可用',
    }
  }

  // 404 表示请求路径没落到上游的生成接口上。OpenAI 兼容格式渠道最常见的原因是
  // Base URL 只填到协议根（如 /v1），或模型 ID 不在该渠道的模型目录里；
  // 上游原文往往只是一句 "404 page not found"，对用户没有可操作性，因此换成定位提示。
  if (status === 404 && provider.toLowerCase() === 'custom') {
    return {
      message: '请求地址未匹配到上游接口（404）：OpenAI 兼容格式渠道的地址需指向 /chat/completions（例如 https://host/v1/chat/completions），同时确认模型 ID 在该渠道可用。',
      errorTitle: '请求地址可能不正确',
    }
  }

  return { message: rawMessage }
}
