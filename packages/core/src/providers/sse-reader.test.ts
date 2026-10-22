import { describe, expect, test } from 'bun:test'
import { OpenAIAdapter } from './openai-adapter.ts'
import { extractTitleFromEventStream, fetchTitleDetailed, fetchTitleWithRetry, streamSSE } from './sse-reader.ts'

const request = { url: 'https://example.test/stream', headers: {}, body: '{}' }

function responseFromText(text: string): typeof fetch {
  return (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  }), { status: 200 })) as unknown as typeof fetch
}

describe('streamSSE', () => {
  test('Given SSE 最后一帧没有换行 When 读取完成 Then 保留最后一段文本', async () => {
    const adapter = new OpenAIAdapter()
    const payload = JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })
    const result = await streamSSE({
      request,
      adapter,
      fetchFn: responseFromText(`data: ${payload}`),
      onEvent: () => {},
    })

    expect(result.content).toBe('tail')
  })

  test('Given OpenAI 并行工具参数交错 When 读取 Chat Completions Then 按 tool index 分配参数', async () => {
    const adapter = new OpenAIAdapter()
    const lines = [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call-a', function: { name: 'search', arguments: '' } },
        { index: 1, id: 'call-b', function: { name: 'read', arguments: '' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: '{"query":"' } },
        { index: 1, function: { arguments: '{"path":"' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: 'docs"}' } },
        { index: 1, function: { arguments: 'README.md"}' } },
      ] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const body = lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join('') + 'data: [DONE]\n\n'

    const result = await streamSSE({
      request,
      adapter,
      fetchFn: responseFromText(body),
      onEvent: () => {},
    })

    expect(result.toolCalls).toEqual([
      { id: 'call-a', name: 'search', arguments: { query: 'docs' }, metadata: { toolIndex: 0 } },
      { id: 'call-b', name: 'read', arguments: { path: 'README.md' }, metadata: { toolIndex: 1 } },
    ])
  })

  test('Given 同一事件帧内 JSON 被拆成多行 data When 读取 Then 按 SSE 规范合并后解析', async () => {
    const adapter = new OpenAIAdapter()
    const body = [
      'data: {"choices":[{"delta":',
      'data: {"content":"multi"}}]}',
      '',
      '',
    ].join('\n')

    const result = await streamSSE({
      request,
      adapter,
      fetchFn: responseFromText(body),
      onEvent: () => {},
    })

    expect(result.content).toBe('multi')
  })

  test('Given CRLF 行尾 When 读取 Then 字段值不携带 \\r 且能正常解析', async () => {
    const adapter = new OpenAIAdapter()
    const payload = JSON.stringify({ choices: [{ delta: { content: 'crlf' } }] })
    const body = `data: ${payload}\r\n\r\n`

    const result = await streamSSE({
      request,
      adapter,
      fetchFn: responseFromText(body),
      onEvent: () => {},
    })

    expect(result.content).toBe('crlf')
  })

  test('Given 流已收到响应头但持续无数据 When 超过 idle timeout Then 终止 reader', async () => {
    const adapter = new OpenAIAdapter()
    const fetchFn = (async () => new Response(new ReadableStream({
      start() {},
    }), { status: 200 })) as unknown as typeof fetch

    await expect(streamSSE({
      request,
      adapter,
      fetchFn,
      idleTimeoutMs: 5,
      onEvent: () => {},
    })).rejects.toThrow('流式响应空闲超过 5ms')
  })
})

describe('fetchTitleDetailed', () => {
  const adapter = new OpenAIAdapter()

  test('Given 网关返回 400 When 请求标题 Then 保留状态码与响应片段', async () => {
    const fetchFn = (async () => new Response('{"error":"model does not support thinking"}', { status: 400 })) as unknown as typeof fetch
    const result = await fetchTitleDetailed(request, adapter, fetchFn)
    expect(result.title).toBeNull()
    expect(result.diagnostics?.status).toBe(400)
    expect(result.diagnostics?.reason).toContain('HTTP 400')
    expect(result.diagnostics?.reason).toContain('model does not support thinking')
  })

  test('Given 响应正常但没有标题文本 When 解析 Then 给出明确原因', async () => {
    const fetchFn = (async () => new Response('{"choices":[{"message":{"content":""}}]}', { status: 200 })) as unknown as typeof fetch
    const result = await fetchTitleDetailed(request, adapter, fetchFn)
    expect(result.title).toBeNull()
    expect(result.diagnostics?.reason).toContain('没有可用的标题文本')
  })

  test('Given 中转站忽略 stream:false 返回 SSE When 请求标题 Then 聚合增量文本', async () => {
    // 真实报错样本：网关返回 `data: {...}`，旧实现直接 response.json() 抛
    // `Unexpected token 'd'`。标题必须能从事件流里聚合出来。
    const sseBody = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":"会话"}}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"标题"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchFn = (async () => new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const result = await fetchTitleDetailed(request, adapter, fetchFn)
    expect(result.title).toBe('会话标题')
  })

  test('Given 网关未声明 content-type 但正文以 data: 开头 When 请求标题 Then 仍按事件流解析', async () => {
    const sseBody = 'data: {"choices":[{"delta":{"content":"移动端"}}]}\ndata: {"choices":[{"delta":{"content":"标题"}}]}\ndata: [DONE]\n'
    const fetchFn = (async () => new Response(sseBody, { status: 200 })) as unknown as typeof fetch
    const result = await fetchTitleDetailed(request, adapter, fetchFn)
    expect(result.title).toBe('移动端标题')
  })

  test('Given Anthropic 事件流 When 请求标题 Then 只聚合 text_delta', () => {
    const body = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"不要用我"}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"标题"}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"内容"}}',
      '',
    ].join('\n')
    expect(extractTitleFromEventStream(body)).toBe('标题内容')
  })

  test('Given 首次返回空补全 When 兼容重试 Then 去掉私有参数并改用流式', async () => {
    const bodies: string[] = []
    let call = 0
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      call += 1
      if (call === 1) {
        return new Response('data: {"choices":[],"usage":{"completion_tokens":0}}\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('data: {"choices":[{"delta":{"content":"兼容标题"}}]}\ndata: [DONE]\n', { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchTitleWithRetry({
      url: 'https://gateway.example.com/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'fixture' }],
        max_tokens: 128,
        thinking: { type: 'disabled' },
        reasoning_effort: 'none',
      }),
    }, adapter, fetchFn)

    expect(result.title).toBe('兼容标题')
    expect(bodies).toHaveLength(2)
    const retryBody = JSON.parse(bodies[1] ?? '{}') as Record<string, unknown>
    expect(retryBody.stream).toBe(true)
    expect(retryBody.thinking).toBeUndefined()
    expect(retryBody.reasoning_effort).toBeUndefined()
    expect(retryBody.max_tokens).toBe(512)
  })

  test('Given 首次就拿到标题 When 请求标题 Then 不做多余重试', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return new Response('{"choices":[{"message":{"content":"一次成功"}}]}', { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchTitleWithRetry(request, adapter, fetchFn)
    expect(result.title).toBe('一次成功')
    expect(calls).toBe(1)
  })

  test('Given 请求抛错 When 请求标题 Then 保留异常信息', async () => {
    const fetchFn = (async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    const result = await fetchTitleDetailed(request, adapter, fetchFn)
    expect(result.title).toBeNull()
    expect(result.diagnostics?.reason).toContain('fetch failed')
  })
})
