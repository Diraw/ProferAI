import { describe, expect, test } from 'bun:test'
import { OpenAIAdapter } from './openai-adapter.ts'
import { streamSSE } from './sse-reader.ts'

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
