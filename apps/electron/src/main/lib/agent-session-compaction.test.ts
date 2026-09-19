import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 会话管理器链路间接导入 Electron；Bun 单测需提供最小主进程 mock。
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

const MAX = 256 * 1024

let root = ''
let sessionsDir = ''
let compaction: typeof import('./agent-session-compaction')
let sessions: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-compaction-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const cacheKey = `${Date.now()}-${Math.random()}`
  compaction = await import(`./agent-session-compaction?compaction-test=${cacheKey}`)
  sessions = await import(`./agent-session-manager?compaction-test=${cacheKey}`)
  configPaths = await import(`./config-paths?compaction-test=${cacheKey}`)
  sessionsDir = configPaths.getAgentSessionsDir()
  mkdirSync(sessionsDir, { recursive: true })
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 真实形态：顶层 tool_use_result 携带整页 HTML，序列化后远超上限 */
function oversizedLine(marker: string): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'M'.repeat(400 * 1024) }] }] },
    tool_use_result: { content: [{ type: 'text', text: `${marker}${'H'.repeat(400 * 1024)}` }], isError: false },
  })
}

function smallLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}

function writeSession(name: string, lines: string[]): string {
  const path = join(sessionsDir, name)
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8')
  return path
}

const readLines = (path: string): string[] => readFileSync(path, 'utf-8').split('\n').filter(Boolean)

describe('历史会话整理 · 只动超限行', () => {
  test('Given 文件含 1 条超限行 + 若干小行 When 整理 Then 只改超限行且其余逐字节不变', async () => {
    const small1 = smallLine('第一条小消息')
    const small2 = smallLine('第二条小消息')
    const big = oversizedLine('BIG-1')
    const path = writeSession('a.jsonl', [small1, big, small2])

    const result = await compaction.compactAgentSessionStorage()

    expect(result.rewrittenFiles).toBe(1)
    expect(result.rewrittenLines).toBe(1)

    const after = readLines(path)
    expect(after).toHaveLength(3)
    expect(after[0]).toBe(small1)          // 逐字节相同
    expect(after[2]).toBe(small2)          // 逐字节相同
    expect(after[1]).not.toBe(big)         // 超限行被改写
    expect(after[1]!.length).toBeLessThanOrEqual(MAX)
    expect(after.every((line) => line.length <= MAX)).toBe(true)
  })

  test('Given 全是小行 When 整理 Then 不写任何文件、不产生备份', async () => {
    const path = writeSession('small.jsonl', [smallLine('a'), smallLine('b')])
    const before = readFileSync(path, 'utf-8')

    const result = await compaction.compactAgentSessionStorage()

    expect(result.rewrittenFiles).toBe(0)
    expect(result.rewrittenLines).toBe(0)
    expect(result.backupDir).toBeUndefined()
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })

  test('Given 多次超限行 When 整理 Then 全部收敛且统计正确', async () => {
    const path = writeSession('multi.jsonl', [oversizedLine('BIG-1'), smallLine('中'), oversizedLine('BIG-2')])

    const result = await compaction.compactAgentSessionStorage()

    expect(result.rewrittenLines).toBe(2)
    expect(result.charsBefore).toBeGreaterThan(800 * 1024)
    expect(result.charsAfter).toBeLessThan(result.charsBefore)
    expect(readLines(path).every((line) => line.length <= MAX)).toBe(true)
  })
})

describe('历史会话整理 · 不丢数据（本模块存在的全部意义）', () => {
  test('Given 超限行 When 整理 Then 原文可完整还原，与整理前逐字节一致', async () => {
    const line = oversizedLine('KEEP-')
    const path = writeSession('recover.jsonl', [line])

    await compaction.compactAgentSessionStorage()

    const after = readLines(path)[0]!
    expect(after.length).toBeLessThanOrEqual(MAX)

    const parsed = JSON.parse(after) as Record<string, unknown>
    expect(Array.isArray(parsed._proferBlobs)).toBe(true)

    // 关键断言：整理【没有丢数据】——还原回去必须等于整理前那一行
    const resolved = await sessions.resolveMessageBlobs(parsed as never)
    expect(JSON.stringify(resolved)).toBe(JSON.stringify(JSON.parse(line)))
  })

  test('Given 整理发生 When 看统计 Then 报出搬到独立存储的份数与字节数', async () => {
    // 同一条内容在同一行里出现两次（message.content 与顶层 tool_use_result 互为副本）
    const shared = 'M'.repeat(400 * 1024)
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: shared }] }] },
      tool_use_result: { content: [{ type: 'text', text: shared }] },
    })
    writeSession('stats.jsonl', [line])

    const result = await compaction.compactAgentSessionStorage()

    expect(result.blobRefs).toBeGreaterThanOrEqual(2)   // 两处引用
    expect(result.blobCount).toBe(1)                     // 内容寻址 ⇒ 只写一份
    expect(result.blobBytes).toBeGreaterThan(0)
    // 行内降得多，但搬到独立存储的只有一份
    expect(result.charsAfter).toBeLessThan(result.charsBefore)
  })

  test('Given 预览 When 看统计 Then 也报出将要搬出的量（不写入）', async () => {
    writeSession('preview-stats.jsonl', [oversizedLine('PVE-')])
    const before = readFileSync(join(sessionsDir, 'preview-stats.jsonl'), 'utf-8')

    const preview = await compaction.previewAgentSessionCompaction()

    expect(preview.blobCount).toBeGreaterThan(0)
    expect(preview.blobBytes).toBeGreaterThan(0)
    expect(readFileSync(join(sessionsDir, 'preview-stats.jsonl'), 'utf-8')).toBe(before)
  })
})

describe('历史会话整理 · 幂等与备份', () => {
  test('Given 已整理过 When 再跑一次 Then 零改动（幂等）', async () => {
    const path = writeSession('idem.jsonl', [oversizedLine('BIG'), smallLine('小')])

    const first = await compaction.compactAgentSessionStorage()
    expect(first.rewrittenLines).toBe(1)

    const afterFirst = readFileSync(path, 'utf-8')
    const second = await compaction.compactAgentSessionStorage()

    expect(second.rewrittenFiles).toBe(0)
    expect(second.rewrittenLines).toBe(0)
    expect(readFileSync(path, 'utf-8')).toBe(afterFirst)   // 第二次完全没碰文件
  })

  test('Given 发生改写 When 检查备份 Then 备份内容等于改写前的原文', async () => {
    const original = [oversizedLine('BIG'), smallLine('小')]
    const path = writeSession('backup.jsonl', original)

    const result = await compaction.compactAgentSessionStorage()

    expect(result.backupDir).toBeDefined()
    const backupPath = join(result.backupDir!, 'backup.jsonl')
    expect(existsSync(backupPath)).toBe(true)
    expect(readFileSync(backupPath, 'utf-8')).toBe(original.join('\n') + '\n')
  })

  test('Given 整理过程 When 检查会话目录 Then 不残留临时文件', async () => {
    writeSession('tmp-check.jsonl', [oversizedLine('BIG')])

    await compaction.compactAgentSessionStorage()

    expect(readdirSync(sessionsDir).filter((n) => n.endsWith('.compact-tmp'))).toHaveLength(0)
  })
})

describe('历史会话整理 · 预览不写入', () => {
  test('Given 调用预览 When 检查磁盘 Then 文件与备份均未产生', async () => {
    const original = [oversizedLine('BIG')]
    const path = writeSession('preview.jsonl', original)

    const preview = await compaction.previewAgentSessionCompaction()

    expect(preview.rewrittenLines).toBe(1)
    expect(preview.charsBefore).toBeGreaterThan(preview.charsAfter)
    expect(readFileSync(path, 'utf-8')).toBe(original.join('\n') + '\n')   // 未改
    expect(preview.backupDir).toBeUndefined()
    expect(existsSync(join(root, 'migrations'))).toBe(false)
  })

  test('Given 预览后再执行 When 比较统计 Then 两者超限行数一致', async () => {
    writeSession('p2.jsonl', [oversizedLine('A'), oversizedLine('B')])
    const preview = await compaction.previewAgentSessionCompaction()
    const applied = await compaction.compactAgentSessionStorage()

    expect(applied.rewrittenLines).toBe(preview.rewrittenLines)
    expect(applied.charsBefore).toBe(preview.charsBefore)
  })
})
