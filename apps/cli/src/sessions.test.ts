import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAgentRuntime } from '@profer/shared'
import { readSessionIndex } from './sessions'

let configDir = ''

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cli-sessions-'))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

function writeIndex(content: unknown): string {
  const path = join(configDir, 'agent-sessions.json')
  writeFileSync(path, JSON.stringify(content), 'utf-8')
  return path
}

describe('CLI 会话索引读取与主进程共用归一', () => {
  test('缺失 agentRuntime 与遗留 knowledgeReferences 与主进程读取结果一致', () => {
    writeIndex({
      version: 1,
      sessions: [{ id: 's1', title: 't', createdAt: 1, updatedAt: 1, knowledgeReferences: [{ id: 'k' }] }],
    })
    const [session] = readSessionIndex({ configDir })
    expect(session?.agentRuntime).toBe(normalizeAgentRuntime(undefined))
    expect(Object.prototype.hasOwnProperty.call(session, 'knowledgeReferences')).toBe(false)
  })

  test('CLI 只读：读取后不回写磁盘上的遗留字段', () => {
    const path = writeIndex({
      version: 1,
      sessions: [{ id: 's1', title: 't', createdAt: 1, updatedAt: 1, knowledgeReferences: [{ id: 'k' }] }],
    })
    const before = readFileSync(path, 'utf-8')
    readSessionIndex({ configDir })
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })

  test('索引文件缺失或损坏时返回空列表', () => {
    expect(readSessionIndex({ configDir })).toEqual([])
    writeFileSync(join(configDir, 'agent-sessions.json'), '{not json', 'utf-8')
    expect(readSessionIndex({ configDir })).toEqual([])
  })
})
