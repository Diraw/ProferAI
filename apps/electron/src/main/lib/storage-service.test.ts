import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@profer/shared'

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
let storageService: typeof import('./storage-service')
let sessions: typeof import('./agent-session-manager')
let blobStore: typeof import('./blob-store')
let configPaths: typeof import('./config-paths')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-storage-blob-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const key = `${Date.now()}-${Math.random()}`
  storageService = await import(`./storage-service?blob-test=${key}`)
  sessions = await import(`./agent-session-manager?blob-test=${key}`)
  blobStore = await import(`./blob-store?blob-test=${key}`)
  configPaths = await import(`./config-paths?blob-test=${key}`)
  mkdirSync(configPaths.getAgentSessionsDir(), { recursive: true })
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 走真实写入路径造一个「被会话引用的 blob」 */
function createSessionWithExternalizedPayload(): void {
  const meta = sessions.createAgentSession('blob category')
  const message = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] }] },
    tool_use_result: { content: [{ type: 'text', text: 'R'.repeat(400_000) }] },
  } as unknown as SDKMessage
  sessions.appendSDKMessages(meta.id, [message])
}

/** 手写一个孤儿 blob（没有任何会话引用它） */
function writeOrphanBlob(content: string): string {
  const hash = blobStore.hashOfBlobContent(content)
  const path = blobStore.blobPathFor(hash)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  return path
}

const blobsCategory = async (): Promise<{ bytes: number; count: number; orphanBytes: number; orphanCount: number }> => {
  const stats = await storageService.calculateStorageStats()
  const category = stats.categories.find((c) => c.key === 'session-blobs')
  expect(category).toBeDefined()
  return category!
}

describe('存储统计 · 会话外置内容', () => {
  test('Given 有被引用的 blob When 统计 Then 计入且不算孤儿', async () => {
    createSessionWithExternalizedPayload()

    const category = await blobsCategory()

    expect(category.count).toBe(1)
    expect(category.bytes).toBe(400_000)   // 恰好就是那个 40 万字符的载荷
    expect(category.orphanCount).toBe(0)
  })

  test('Given 混有孤儿 blob When 统计 Then 只有孤儿被计入 orphanCount', async () => {
    createSessionWithExternalizedPayload()
    writeOrphanBlob('orphan-one')
    writeOrphanBlob('orphan-two')

    const category = await blobsCategory()

    expect(category.count).toBe(3)          // 1 被引用 + 2 孤儿
    expect(category.orphanCount).toBe(2)
    expect(category.orphanBytes).toBeGreaterThan(0)
  })

  test('Given 没有任何 blob When 统计 Then 该项为 0 且无孤儿', async () => {
    const category = await blobsCategory()
    expect(category.count).toBe(0)
    expect(category.bytes).toBe(0)
    expect(category.orphanCount).toBe(0)
  })
})

describe('孤儿清理 · 只删没被引用的载荷', () => {
  test('Given 混合 When 清理孤儿 Then 在用的保留、孤儿删除', async () => {
    createSessionWithExternalizedPayload()
    const usedPath = findOnlyBlobPath()          // 真实写入路径造出来的那个被引用的 blob
    const orphanPath = writeOrphanBlob('to-be-removed')

    expect(existsSync(usedPath)).toBe(true)
    expect(existsSync(orphanPath)).toBe(true)

    const result = await storageService.cleanupStorage({ categories: ['session-blobs'], orphansOnly: true, archivedBeforeDays: 0 })

    // 关键安全断言：在用的那条绝不能被删
    expect(existsSync(usedPath)).toBe(true)
    expect(existsSync(orphanPath)).toBe(false)
    expect(result.deletedCount).toBe(1)
    expect(result.freedBytes).toBeGreaterThan(0)
  })

  test('Given 只有被引用载荷 When 清理孤儿 Then 一个都不删', async () => {
    createSessionWithExternalizedPayload()
    const before = await blobsCategory()

    const result = await storageService.cleanupStorage({ categories: ['session-blobs'], orphansOnly: true, archivedBeforeDays: 0 })

    expect(result.deletedCount).toBe(0)
    const after = await blobsCategory()
    expect(after.count).toBe(before.count)
    expect(after.count).toBe(1)
  })

  test('Given 清理完 When 再统计 Then 孤儿归零', async () => {
    createSessionWithExternalizedPayload()
    writeOrphanBlob('o1')
    writeOrphanBlob('o2')

    await storageService.cleanupStorage({ categories: ['session-blobs'], orphansOnly: true, archivedBeforeDays: 0 })

    const category = await blobsCategory()
    expect(category.orphanCount).toBe(0)
    expect(category.count).toBe(1)
  })
})

/** 在 blob 目录里找出唯一的文件的完整路径（即被引用的那个） */
function findOnlyBlobPath(): string {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (!entry.includes('.tmp-')) found.push(full)
    }
  }
  walk(blobStore.blobRootDir())
  expect(found).toHaveLength(1)
  return found[0]!
}
