import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@profer/shared'

// 会话管理器经 workspace 服务间接导入 Electron；Bun 单测需提供最小主进程 mock。
mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

/** 与源码保持一致：单行序列化上限 256K chars，截断阈值取其一半 */
const MAX_SDK_MESSAGE_LENGTH = 256 * 1024
const TRUNCATION_MARK = '内容已截断'

let root = ''
let sessions: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-oversized-sanitize-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  sessions = await import(`./agent-session-manager?oversized-test=${cacheKey}`)
  configPaths = await import(`./config-paths?oversized-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 写一条消息并回读它的落盘行，用于断言最终体积与结构 */
function writeAndReadLine(message: SDKMessage): Record<string, unknown> {
  const meta = sessions.createAgentSession('oversized sanitize')
  sessions.appendSDKMessages(meta.id, [message])
  const file = join(configPaths.getAgentSessionsDir(), `${meta.id}.jsonl`)
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const last = lines[lines.length - 1]!
  expect(last.length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
  return JSON.parse(last) as Record<string, unknown>
}

const bigString = (n: number): string => 'A'.repeat(n)

describe('超大消息落盘收敛', () => {
  test('Given 顶层 tool_use_result 携带整页 HTML When 落盘 Then 被截断且整行不超限', () => {
    // 真实形态：{content:[{type:'text',text:'<!DOCTYPE html>...'}], isError}
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      tool_use_result: { content: [{ type: 'text', text: bigString(400_000) }], isError: false },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)
    const details = persisted.tool_use_result as { content: Array<{ type: string; text: string }> }

    expect(details.content[0]!.text.length).toBeLessThan(3000)
    expect(details.content[0]!.text).toContain(TRUNCATION_MARK)
  })

  test('Given 顶层 tool_use_result 携带 PDF base64 When 落盘 Then base64 被截断', () => {
    // 真实形态：{type:'pdf', file:{filePath, base64}}（实测单条最大 9.4 MB）
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'ok' }] },
      tool_use_result: { type: 'pdf', file: { filePath: 'W:\spec.pdf', base64: `JVBERi0${bigString(400_000)}` } },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)
    const details = persisted.tool_use_result as { file: { filePath: string; base64: string } }

    expect(details.file.filePath).toBe('W:\spec.pdf')
    expect(details.file.base64).toContain(TRUNCATION_MARK)
    expect(details.file.base64.length).toBeLessThan(3000)
  })

  test('Given message.content 内嵌扁平 data 图片 When 落盘 Then base64 被剥离为轻量标记', () => {
    // Pi 风格：{type:'image', data, mimeType}；此前代码只认 source.data，实测约 95 MB 漏处理
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_3',
          content: [
            { type: 'text', text: 'Screenshot rendered (returned inline).' },
            { type: 'image', data: `iVBORw0KGgo${bigString(400_000)}`, mimeType: 'image/png' },
          ],
        }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)
    const blocks = (persisted.message as { content: Array<{ content: unknown[] }> }).content
    const image = blocks[0]!.content[1] as Record<string, unknown>

    expect(image.type).toBe('image')
    expect(image._truncated).toBe(true)
    expect(image._originalLength).toBeGreaterThan(400_000)
    expect(image.data).toBeUndefined()
  })

  test('Given Anthropic 风格 source.data 图片 When 落盘 Then 原有剥离行为保持不变', () => {
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_4',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `iVBORw0KGgo${bigString(400_000)}` } }],
        }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)
    const blocks = (persisted.message as { content: Array<{ content: unknown[] }> }).content
    const image = blocks[0]!.content[0] as Record<string, unknown>

    expect(image._truncated).toBe(true)
    expect(image._originalLength).toBeGreaterThan(400_000)
  })

  test('Given 嵌套在数组里的超长 text block When 落盘 Then 被截断（此前不受限）', () => {
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_5',
          content: [{ type: 'text', text: bigString(400_000) }],
        }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)
    const blocks = (persisted.message as { content: Array<{ content: Array<{ text: string }> }> }).content
    const text = blocks[0]!.content[0]!.text

    expect(text.length).toBeLessThan(3000)
    expect(text).toContain(TRUNCATION_MARK)
  })

  test('Given 未超限的普通消息 When 落盘 Then 内容与结构完全不被改动', () => {
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_6',
          content: [{ type: 'text', text: '短文本' }, { type: 'image', data: 'short', mimeType: 'image/png' }],
        }],
      },
      tool_use_result: { content: [{ type: 'text', text: '同样很短' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const persisted = writeAndReadLine(message)
    const blocks = (persisted.message as { content: Array<{ content: unknown[] }> }).content

    expect((blocks[0]!.content[0] as { text: string }).text).toBe('短文本')
    expect((blocks[0]!.content[1] as { data: string }).data).toBe('short')
    expect((persisted.tool_use_result as { content: Array<{ text: string }> }).content[0]!.text).toBe('同样很短')
  })
})

describe('转义膨胀场景', () => {
  test('Given 原文未超阈值但 JSON 转义后膨胀 When 落盘 Then 逐级收紧后仍落入限内', () => {
    // 每个 U+0001 序列化后变成 6 个字符（\u0001），100K 原文 → 约 600K JSON。
    // 只按原文长度判断会漏掉这种情况，必须按实际序列化结果逐级收紧。
    const controlHeavy = '\u0001'.repeat(100_000)
    expect(controlHeavy.length).toBeLessThan(MAX_SDK_MESSAGE_LENGTH / 2)
    expect(JSON.stringify(controlHeavy).length).toBeGreaterThan(MAX_SDK_MESSAGE_LENGTH)

    const message = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_7', content: [{ type: 'text', text: controlHeavy }] }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    // writeAndReadLine 内部会断言落盘行 ≤ 上限
    const persisted = writeAndReadLine(message)
    const blocks = (persisted.message as { content: Array<{ content: Array<{ text: string }> }> }).content
    const text = blocks[0]!.content[0]!.text

    expect(text.length).toBeLessThan(3000)
    expect(text).toContain(TRUNCATION_MARK)
  })

  test('Given 多个中等字段累加超限 When 落盘 Then 也被收敛（非单个巨字段场景）', () => {
    // 参考真机残留样本：单字段均低于阈值，但多字段累加超过上限
    const mid = 'B'.repeat(60_000)
    const message = {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_8',
          content: [{ type: 'text', text: mid }, { type: 'text', text: mid }, { type: 'text', text: mid }],
        }],
      },
      tool_use_result: { output: mid, truncation: { content: mid } },
      parent_tool_use_id: null,
    } as unknown as SDKMessage

    const rawLineLength = JSON.stringify(message).length
    expect(rawLineLength).toBeGreaterThan(MAX_SDK_MESSAGE_LENGTH)

    const persisted = writeAndReadLine(message)
    expect(JSON.stringify(persisted).length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
  })
})
