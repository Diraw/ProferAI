/**
 * 共享 SSE 流式读取器
 *
 * 封装所有供应商通用的 SSE 解析逻辑：
 * - fetch 调用 + 错误检查
 * - ReadableStream reader + TextDecoder 管理
 * - 逐行 buffer 分割 + data: 前缀检测 + [DONE] 哨兵处理
 * - 通过 adapter.parseSSELine() 委托供应商特定解析
 * - 通过回调分发事件
 * - 累积工具调用信息（tool use 支持）
 */

import type { ProviderAdapter, ProviderRequest, StreamEventCallback, ThinkingBlock, ToolCall } from './types.ts'

// ===== 流式请求 =====

/** streamSSE 的输入选项 */
export interface StreamSSEOptions {
  /** 构建好的 HTTP 请求配置 */
  request: ProviderRequest
  /** 供应商适配器（用于解析 SSE 行） */
  adapter: ProviderAdapter
  /** 事件回调 */
  onEvent: StreamEventCallback
  /** AbortSignal 用于取消请求 */
  signal?: AbortSignal
  /** 等待 HTTP 响应头的超时（毫秒），默认 30s。 */
  timeoutMs?: number
  /** 两个流式 chunk 之间的最大空闲时间（毫秒），默认 120s。 */
  idleTimeoutMs?: number
  /** 自定义 fetch 函数（代理等场景下由调用方注入） */
  fetchFn?: typeof globalThis.fetch
}

/** streamSSE 的返回结果 */
export interface StreamSSEResult {
  /** 累积的完整文本内容 */
  content: string
  /** 累积的推理内容（扁平文本，所有思考块拼接） */
  reasoning: string
  /**
   * 结构化的思考块（每块含 thinking 文本和可选 signature）
   *
   * 思考+工具模式下必须原样（含签名）回传给 Anthropic 协议家族服务端：
   * 签名缺失时会被 DeepSeek v4 等服务端以 "content[].thinking must be passed back" 拒绝。
   */
  thinkingBlocks: ThinkingBlock[]
  /** 本轮返回的工具调用列表 */
  toolCalls: ToolCall[]
  /** 停止原因（'tool_use' 表示需要执行工具后继续） */
  stopReason?: string
}

// ===== 首字节前自动重试 =====
//
// 仅在「尚未向 UI 发出任何事件」时重试，一旦开始流式输出就不再重试——
// 否则已渲染的内容会与重试产生的内容重复。覆盖场景：fetch 网络错误、
// 瞬时 HTTP 状态（408/429/5xx）、以及 200 之后首事件前的连接中断。

/** 首字节前最大自动重试次数 */
const MAX_SSE_RETRIES = 5

/** 累计重试等待预算（毫秒）——交互式 Chat，用户在等待，预算比 Agent 编排短 */
const MAX_SSE_RETRY_WAIT_MS = 30_000

/** 单次重试延迟上限（毫秒） */
const SSE_RETRY_MAX_DELAY_MS = 8_000

/** HTTP 错误携带状态码，便于重试决策 */
class HTTPError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HTTPError'
  }
}

/** Provider 在 200 流内返回的语义错误，通常不是瞬时网络问题，不应自动重试。 */
class ProviderStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderStreamError'
  }
}

/**
 * 计算重试延迟（指数退避 + ±20% jitter）
 *
 * 基础序列：1s, 2s, 4s, 8s, 8s...（cap = 8s），叠加 ±20% 抖动避免惊群。
 * 累计等待限制在 {@link MAX_SSE_RETRY_WAIT_MS} 内，预算耗尽返回 0（表示放弃）。
 */
function getSSERetryDelayMs(attempt: number, elapsedRetryDelayMs: number): number {
  const remainingMs = MAX_SSE_RETRY_WAIT_MS - elapsedRetryDelayMs
  if (remainingMs <= 0) return 0

  const base = Math.min(1000 * Math.pow(2, attempt - 1), SSE_RETRY_MAX_DELAY_MS)
  const jitter = base * (Math.random() * 0.4 - 0.2)
  return Math.min(remainingMs, Math.max(0, Math.round(base + jitter)))
}

/**
 * 判断错误是否可重试
 *
 * - 带 HTTP 状态码：仅 408/429/5xx（瞬时）可重试，其余 4xx 为永久错误
 * - 无状态码（网络错误 / 流读取中断 / 空响应体）：视为瞬时问题，可重试
 */
function isRetriableError(error: unknown): boolean {
  if (error instanceof ProviderStreamError || error instanceof StreamIdleTimeoutError) return false
  if (error instanceof HTTPError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
  }
  return true
}

/** 可被 AbortSignal 立即打断的 sleep；abort 时 reject AbortError */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 执行流式 SSE 请求（含首字节前自动重试）
 *
 * 通用流程：
 * 1. 发起 fetch POST 请求
 * 2. 检查响应状态
 * 3. 获取 ReadableStream reader，逐 chunk 读取
 * 4. 按换行分行，过滤 "data: " 前缀和 "[DONE]" 哨兵
 * 5. 调用 adapter.parseSSELine() 解析供应商特定 JSON
 * 6. 累积 content/reasoning/toolCalls，通过 onEvent 回调分发
 * 7. 返回完整内容
 *
 * 重试语义：仅当本次尝试尚未通过 onEvent 发出任何事件时才重试，
 * 确保不会向 UI 重复推送内容。
 */
export async function streamSSE(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { signal } = options

  let elapsedRetryDelayMs = 0

  for (let attempt = 1; ; attempt++) {
    // 跟踪本次尝试是否已发出事件——一旦发出就不能再重试
    let hasEmitted = false
    const trackedOptions: StreamSSEOptions = {
      ...options,
      onEvent: (event) => {
        hasEmitted = true
        options.onEvent(event)
      },
    }

    try {
      return await runStreamAttempt(trackedOptions)
    } catch (error) {
      // 用户主动取消：不重试
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      // 已向 UI 发出过事件：重试会导致内容重复
      if (hasEmitted) throw error
      // 永久性错误（4xx 等）或已达重试上限：直接抛出
      if (!isRetriableError(error) || attempt >= MAX_SSE_RETRIES) throw error

      const delay = getSSERetryDelayMs(attempt, elapsedRetryDelayMs)
      if (delay <= 0) throw error // 等待预算耗尽
      elapsedRetryDelayMs += delay

      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[streamSSE] 首字节前出错，${delay}ms 后第 ${attempt} 次重试: ${msg}`)
      await sleepWithAbort(delay, signal)
    }
  }
}

function normalizeToolCallOutputIndex(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value) return value
  return undefined
}

class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`流式响应空闲超过 ${timeoutMs}ms`)
    this.name = 'StreamIdleTimeoutError'
  }
}

/** 单次 SSE 流式尝试（不含重试逻辑） */
async function runStreamAttempt(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { request, adapter, onEvent, signal, fetchFn = fetch, timeoutMs = 30_000, idleTimeoutMs = 120_000 } = options

  // 真正的"首字节超时"：仅在等待 HTTP 响应期间计时，收到响应后立即清除。
  // 使用 setTimeout + clearTimeout 而非 AbortSignal.timeout() 因为后者是绝对超时，
  // 会无条件 abort 整个流（包括已开始的内容输出），导致正常长回复被截断。
  // 超时产生的 AbortError 会被外层 streamSSE 的 isRetriableError 识别为可重试，
  // 从而触发指数退避重试（最多 5 次 / 30s 预算）。
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(new DOMException('First byte timeout', 'TimeoutError')), timeoutMs)
  const effectiveSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  // 1. 发起请求（支持通过 fetchFn 注入代理）
  let response: Response
  try {
    response = await fetchFn(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: effectiveSignal,
  })
  } catch (error) {
    clearTimeout(timer)
    throw error
  }

  // 已收到 HTTP 响应头，清除首字节超时；正文读取由 idleTimeoutMs 保护。
  clearTimeout(timer)

  // 2. 错误检查
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new HTTPError(`${adapter.providerType} API 错误 (${response.status}): ${text.slice(0, 300)}`, response.status)
  }

  if (!response.body) {
    throw new Error('响应体为空')
  }

  // 3. 读取流
  let content = ''
  let reasoning = ''
  let stopReason: string | undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // 工具调用追踪
  const pendingToolCalls = new Map<string, { id: string; name: string; args: string; metadata?: Record<string, unknown> }>()
  const toolCallIdsByOutputIndex = new Map<string, string>()
  let currentToolCallId: string | undefined

  // 思考块追踪（Anthropic 协议：每个 thinking 块由多个 thinking_delta + signature_delta 组成）
  const thinkingBlocks: ThinkingBlock[] = []
  let currentThinking: ThinkingBlock | null = null

  // SSE 事件帧：以空行分隔；同帧内多行 `data:` 按规范用 \n 连接后再解析。
  let pendingData: string[] = []

  /** 派发当前积累的事件帧（遇到空行或流结束时调用）。 */
  const dispatchPendingEvent = (): void => {
    if (pendingData.length === 0) return
    const data = pendingData.join('\n')
    pendingData = []
    if (!data || data === '[DONE]') return

    const events = adapter.parseSSELine(data)
    for (const event of events) {
      let emitEvent = true
      if (event.type === 'chunk') {
        content += event.delta
      } else if (event.type === 'reasoning') {
        reasoning += event.delta
        if (currentThinking) currentThinking.thinking += event.delta
        else {
          currentThinking = { thinking: event.delta }
          thinkingBlocks.push(currentThinking)
        }
      } else if (event.type === 'reasoning_signature') {
        if (currentThinking) currentThinking.signature = (currentThinking.signature ?? '') + event.signature
        else {
          currentThinking = { thinking: '', signature: event.signature }
          thinkingBlocks.push(currentThinking)
        }
      } else if (event.type === 'reasoning_block_start') {
        currentThinking = { thinking: '' }
        thinkingBlocks.push(currentThinking)
      } else if (event.type === 'reasoning_block_stop') {
        currentThinking = null
      } else if (event.type === 'tool_call_start') {
        currentToolCallId = event.toolCallId
        const outputIndex = normalizeToolCallOutputIndex(event.metadata?.outputIndex ?? event.metadata?.toolIndex)
        if (outputIndex) toolCallIdsByOutputIndex.set(outputIndex, event.toolCallId)
        const existing = pendingToolCalls.get(event.toolCallId)
        if (existing?.name === event.toolName) emitEvent = false
        pendingToolCalls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          args: existing?.args ?? '',
          metadata: { ...existing?.metadata, ...event.metadata },
        })
      } else if (event.type === 'tool_call_delta') {
        const outputIndex = event.toolIndex !== undefined
          ? String(event.toolIndex)
          : normalizeToolCallOutputIndex(event.metadata?.outputIndex)
        const tcId = event.toolCallId || (outputIndex ? toolCallIdsByOutputIndex.get(outputIndex) : undefined) || currentToolCallId
        if (tcId) {
          const pending = pendingToolCalls.get(tcId)
          if (!pending) throw new ProviderStreamError(`收到未知工具调用参数: ${tcId}`)
          pending.args = event.finalArguments !== undefined ? event.finalArguments : pending.args + event.argumentsDelta
        }
      } else if (event.type === 'done' && event.stopReason) {
        stopReason = event.stopReason
      } else if (event.type === 'error') {
        throw new ProviderStreamError(event.error)
      }
      if (emitEvent) onEvent(event)
    }
  }

  /** 解析一行 SSE；空行代表一个事件帧结束。 */
  const processLine = (rawLine: string): void => {
    // 兼容 CRLF：\r 属于换行符，不属于字段值。
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') { dispatchPendingEvent(); return }
    if (line.startsWith(':')) return // 注释/心跳行
    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    // SSE 规范：冒号后的第一个空格是分隔符，需要剥离（值本身可含前导空格）。
    if (value.startsWith(' ')) value = value.slice(1)
    // event/id/retry 字段由 adapter 依据 JSON 自身判定，这里只收集数据体。
    if (field === 'data') pendingData.push(value)
  }

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => reject(new StreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs)
        }),
      ]).finally(() => {
        if (idleTimer) clearTimeout(idleTimer)
      })
      const { done, value } = next
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) processLine(line)
    }
    // SSE 服务端不保证最后一帧以换行结束；flush decoder 后逐行处理残余，并派发尾帧。
    buffer += decoder.decode()
    if (buffer) for (const line of buffer.split('\n')) processLine(line)
    dispatchPendingEvent()
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }

  // 将 pending 工具调用解析为最终结果
  const toolCalls: ToolCall[] = []
  for (const [, pending] of pendingToolCalls) {
    try {
      toolCalls.push({
        id: pending.id,
        name: pending.name,
        arguments: pending.args ? JSON.parse(pending.args) : {},
        metadata: pending.metadata,
      })
    } catch (error) {
      throw new ProviderStreamError(`工具 ${pending.name} 参数不是完整 JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 有工具调用但无显式 stopReason 时自动推断
  if (toolCalls.length > 0 && !stopReason) {
    stopReason = 'tool_use'
  }

  onEvent({ type: 'done', stopReason })
  return { content, reasoning, thinkingBlocks, toolCalls, stopReason }
}

// ===== 非流式标题请求 =====

/** 标题请求失败的结构化原因；用于把「模型调用失败」和「没有可用结果」区分开。 */
export interface TitleFetchDiagnostics {
  /** HTTP 状态码（网络异常时为 undefined）。 */
  status?: number
  /** 可直接展示给用户的失败原因（含状态码与响应片段）。 */
  reason: string
}

export interface TitleFetchResult {
  title: string | null
  diagnostics?: TitleFetchDiagnostics
}

/** 把响应里的内容块（字符串 / 内容块数组）归一为纯文本。 */
function normalizeTitleContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

/**
 * 从单个 SSE 事件载荷中提取增量标题文本。
 *
 * 覆盖三种标题会用到的协议：OpenAI Chat Completions、Anthropic Messages 与
 * OpenAI Responses。只取可见文本，不把 reasoning / thinking 增量混进标题。
 */
function extractTitleDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const data = payload as Record<string, unknown>

  const choices = data.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown> | undefined
    const delta = choice?.delta as Record<string, unknown> | undefined
    const message = choice?.message as Record<string, unknown> | undefined
    return normalizeTitleContent(delta?.content)
      || normalizeTitleContent(message?.content)
      || normalizeTitleContent(choice?.text)
  }

  const delta = data.delta as Record<string, unknown> | undefined
  if (data.type === 'content_block_delta' && delta?.type === 'text_delta') {
    return typeof delta.text === 'string' ? delta.text : ''
  }
  if (data.type === 'content_block_start') {
    const contentBlock = data.content_block as Record<string, unknown> | undefined
    if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string') return contentBlock.text
  }

  if (typeof data.type === 'string' && data.type.endsWith('output_text.delta')) {
    return typeof data.delta === 'string' ? data.delta : ''
  }
  const response = data.response as Record<string, unknown> | undefined
  if (typeof response?.output_text === 'string') return response.output_text

  return ''
}

/**
 * 把 `data:` 事件流正文聚合成标题文本；不是事件流时返回空串。
 *
 * 中转站常见两种返回：真正的 SSE，或 `data: {...}\n\ndata: [DONE]` 的伪流式。
 * 两种都按行解析，心跳/非 JSON 行直接忽略。
 */
export function extractTitleFromEventStream(body: string): string {
  let text = ''
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      text += extractTitleDelta(JSON.parse(payload))
    } catch {
      // 非 JSON 的心跳/注释行不参与标题。
    }
  }
  return text.trim()
}

/**
 * 执行非流式标题生成请求，并保留失败原因。
 *
 * 标题是旁路请求：失败不能阻断运行，但也不能像之前那样只返回 null 让上层
 * 静默回退。调用方可以用 diagnostics.reason 向用户解释到底是 401/404/超时
 * 还是响应里没有标题文本。
 *
 * @param request 构建好的 HTTP 请求配置
 * @param adapter 供应商适配器（用于解析响应）
 */
export async function fetchTitleDetailed(
  request: ProviderRequest,
  adapter: ProviderAdapter,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<TitleFetchResult> {  try {
    console.log('[fetchTitle] 发送请求:', {
      url: request.url,
      provider: adapter.providerType,
      bodyPreview: request.body.slice(0, 200),
    })

    const response = await fetchFn(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })

    console.log('[fetchTitle] 收到响应:', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown')
      console.warn('[fetchTitle] 请求失败:', {
        status: response.status,
        error: errorText.slice(0, 500),
      })
      const snippet = errorText.trim().slice(0, 300)
      return {
        title: null,
        diagnostics: {
          status: response.status,
          reason: `HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
        },
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const bodyText = await response.text()
    const trimmed = bodyText.trim()
    const snippet = trimmed.slice(0, 300)

    // 部分中转站/新 API 网关会忽略非流式请求，直接返回 `data: {...}` 的 SSE 正文。
    // 先按 JSON 解析；失败或声明为事件流时，回退到 SSE 事件聚合，避免把流式响应
    // 当成非法 JSON 报错（“Unexpected token 'd'”）。
    const looksLikeEventStream = /text\/event-stream/i.test(contentType)
      || trimmed.startsWith('data:')
      || trimmed.startsWith('event:')

    let title: string | null = null
    if (!looksLikeEventStream) {
      try {
        const data: unknown = JSON.parse(bodyText)
        console.log('[fetchTitle] 解析响应体:', {
          provider: adapter.providerType,
          dataPreview: JSON.stringify(data).slice(0, 500),
        })
        title = adapter.parseTitleResponse(data)
      } catch {
        console.warn('[fetchTitle] 响应不是合法 JSON，尝试按 SSE 解析:', snippet)
      }
    }

    if (!title) {
      title = extractTitleFromEventStream(bodyText)
    }

    console.log('[fetchTitle] 解析标题结果:', { title })
    if (!title) {
      return {
        title: null,
        diagnostics: {
          status: response.status,
          reason: trimmed
            ? `响应中没有可用的标题文本: ${snippet}`
            : '响应中没有可用的标题文本',
        },
      }
    }
    return { title }
  } catch (error) {
    console.error('[fetchTitle] 异常:', error)
    return {
      title: null,
      diagnostics: { reason: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * 执行非流式标题生成请求
 *
 * @param request 构建好的 HTTP 请求配置
 * @param adapter 供应商适配器（用于解析响应）
 * @returns 提取的标题文本，失败返回 null
 */
export async function fetchTitle(
  request: ProviderRequest,
  adapter: ProviderAdapter,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<string | null> {
  return (await fetchTitleWithRetry(request, adapter, fetchFn)).title
}

/**
 * 构造「兼容重试」的标题请求。
 *
 * 部分第三方网关对推理模型 + 非流式 + 厂商私有参数（`thinking` / `reasoning_effort`）
 * 的组合会返回 200 但 `completion_tokens: 0`（真实样本：`choices: []` 的 usage chunk）。
 * 重试时只保留最通用的 Chat Completions 字段，并显式开流式——网关对流的支持
 * 比非流式广；同时放宽标题预算，避免推理吃光 token 后没有正文。
 */
export function buildCompatibleTitleRetryRequest(request: ProviderRequest): ProviderRequest {
  try {
    const body = JSON.parse(request.body) as Record<string, unknown>
    body.stream = true
    if (typeof body.max_tokens === 'number') body.max_tokens = 512
    if (typeof body.max_output_tokens === 'number') body.max_output_tokens = 512
    delete body.thinking
    delete body.reasoning
    delete body.reasoning_effort
    delete body.stream_options
    return { ...request, body: JSON.stringify(body) }
  } catch {
    return request
  }
}

/**
 * 标题请求（带一次兼容重试）。
 *
 * 第一次失败常见于中转站的返回形态差异（SSE/参数严格）；兼容重试只会在
 * 首次确实没拿到标题时发生，不会对正常渠道多发请求。
 */
export async function fetchTitleWithRetry(
  request: ProviderRequest,
  adapter: ProviderAdapter,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<TitleFetchResult> {
  const first = await fetchTitleDetailed(request, adapter, fetchFn)
  if (first.title) return first

  // 鉴权/路由错误重试没有意义（同一地址、同一凭据）；只对「参数过严 / 空补全 / 网络抖动」
  // 这类可能被兼容参数救回来的失败重试一次。Google 的标题请求没有 stream 字段，不参与。
  const status = first.diagnostics?.status
  if (adapter.providerType === 'google' || status === 401 || status === 403 || status === 404) return first

  const retryRequest = buildCompatibleTitleRetryRequest(request)
  if (retryRequest.body === request.body) return first

  console.warn('[fetchTitle] 首次未取得标题，使用兼容参数重试一次')
  const retry = await fetchTitleDetailed(retryRequest, adapter, fetchFn)
  if (retry.title) return retry

  const firstReason = first.diagnostics?.reason ?? '未知原因'
  const retryReason = retry.diagnostics?.reason ?? '未知原因'
  return {
    title: null,
    diagnostics: {
      status: retry.diagnostics?.status ?? first.diagnostics?.status,
      reason: `首次失败: ${firstReason}；兼容重试失败: ${retryReason}`,
    },
  }
}
