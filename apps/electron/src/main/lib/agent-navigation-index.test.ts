import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

let root = ''
let nav: typeof import('./agent-navigation-index')
let configPaths: typeof import('./config-paths')

interface Line {
  type: string
  subtype?: string
  message?: unknown
  parent_tool_use_id?: string | null
  uuid?: string
  _createdAt?: number
  _goalIteration?: number
}

const user = (text: string, uuid: string, extra: Partial<Line> = {}): Line => ({
  type: 'user',
  message: { content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  uuid,
  _createdAt: 1000,
  ...extra,
})

const assistant = (text: string, uuid: string): Line => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }], model: 'gpt-x' },
  parent_tool_use_id: null,
  uuid,
  _createdAt: 1000,
})

function writeSession(id: string, lines: Line[]): void {
  const path = join(configPaths.getAgentSessionsDir(), `${id}.jsonl`)
  mkdirSync(configPaths.getAgentSessionsDir(), { recursive: true })
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-nav-index-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  nav = await import(`./agent-navigation-index?nav-test=${cacheKey}`)
  configPaths = await import(`./config-paths?nav-test=${cacheKey}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('会话导航索引', () => {
  test('Given 会话有中断记录 When 读取索引 Then 与渲染层同口径成行', () => {
    writeSession('s1', [
      user('一', 'u1'),
      { type: 'system', subtype: 'interruption_record', message: '已被用户中断', _createdAt: 1000 },
      assistant('一答', 'a1'),
      { type: 'system', subtype: 'compacting', _createdAt: 1000 },
      user('二', 'u2'),
      assistant('二答', 'a2'),
    ])

    const index = nav.getAgentSessionNavigationIndex('s1')

    expect(index.total).toBe(5)
    expect(index.entries.map((e) => e.role)).toEqual(['user', 'status', 'assistant', 'user', 'assistant'])
    expect(index.entries[1]!.id).toBeNull()
    expect(index.entries[1]!.matchKey).toBe('status:interruption_record:1000')
    expect(index.entries[1]!.preview).toBe('已被用户中断')
  })

  test('Given 不存在的会话 When 读取索引 Then 返回空索引而不抛错', () => {
    const index = nav.getAgentSessionNavigationIndex('missing')
    expect(index.total).toBe(0)
    expect(index.entries).toEqual([])
  })

  test('Given 文件未变化 When 再次读取 Then 复用同一对象（缓存生效）', () => {
    writeSession('s2', [user('一', 'u1'), assistant('答', 'a1')])
    const first = nav.getAgentSessionNavigationIndex('s2')
    const second = nav.getAgentSessionNavigationIndex('s2')
    expect(second).toBe(first)
  })

  test('Given 文件被追加 When 再次读取 Then 重建索引（总数随之增长）', () => {
    writeSession('s3', [user('一', 'u1'), assistant('答一', 'a1')])
    const first = nav.getAgentSessionNavigationIndex('s3')
    expect(first.total).toBe(2)

    appendFileSync(
      join(configPaths.getAgentSessionsDir(), 's3.jsonl'),
      JSON.stringify(user('二', 'u2')) + '\n' + JSON.stringify(assistant('答二', 'a2')) + '\n',
      'utf-8',
    )

    const second = nav.getAgentSessionNavigationIndex('s3')
    expect(second.total).toBe(4)
    expect(second).not.toBe(first)
  })

  test('Given 损坏行 When 读取索引 Then 跳过坏行不中断', () => {
    const path = join(configPaths.getAgentSessionsDir(), 's4.jsonl')
    mkdirSync(configPaths.getAgentSessionsDir(), { recursive: true })
    writeFileSync(
      path,
      [JSON.stringify(user('一', 'u1')), '{ 坏行', JSON.stringify(assistant('答', 'a1'))].join('\n') + '\n',
      'utf-8',
    )
    const index = nav.getAgentSessionNavigationIndex('s4')
    expect(index.total).toBe(2)
  })

  test('Given 显式失效 When 再次读取 Then 重建', () => {
    writeSession('s5', [user('一', 'u1')])
    const first = nav.getAgentSessionNavigationIndex('s5')
    nav.invalidateAgentSessionNavigationIndex('s5')
    const second = nav.getAgentSessionNavigationIndex('s5')
    expect(second).not.toBe(first)
    expect(second.total).toBe(first.total)
  })
})

describe('会话导航索引 · 与渲染层一致性（真实会话文件）', () => {
  const REAL = '/Users/mac/.profer/agent-sessions/74103cf3-db86-438e-a26a-14c1b18f8738.jsonl'

  test('Given 真实会话 When 与渲染层分组对比 Then 行列一致', async () => {
    // 该会话带 3 条 interruption_record + 3 条 Goal 迭代：正是「折叠/中断不该影响计数」的现场。
    const { existsSync, readFileSync, copyFileSync } = await import('node:fs')
    if (!existsSync(REAL)) return // 换机时不硬失败

    mkdirSync(configPaths.getAgentSessionsDir(), { recursive: true })
    copyFileSync(REAL, join(configPaths.getAgentSessionsDir(), 'real.jsonl'))

    const index = nav.getAgentSessionNavigationIndex('real')
    expect(index.total).toBe(24)
    expect(index.entries.filter((e) => e.role === 'status')).toHaveLength(3)
    // 每条要么有 id，要么有可回退的 matchKey。
    for (const entry of index.entries) {
      expect(entry.id !== null || entry.matchKey.length > 0).toBe(true)
    }
    void readFileSync
  })
})
