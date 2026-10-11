import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORAGE_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'storage-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('存储 IPC 注册（结构检查）', () => {
  test('覆盖存储通道并保留启动生命周期', () => {
    for (const key of ['GET_STATS', 'CLEANUP', 'CLEANUP_TEMP', 'SESSION_COMPACTION_PREVIEW', 'SESSION_COMPACTION_APPLY', 'SESSION_RESOLVE_BLOBS'] as const) expect(source).toContain(`STORAGE_IPC_CHANNELS.${key}`)
    expect(source).toContain('setInterval(runAutoArchive')
    expect(source).toContain('runStartupCleanup')
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(ipc).toContain('registerStorageIpc()')
    expect(ipc).not.toContain('ipcMain.handle(STORAGE_IPC_CHANNELS.GET_STATS')
  })
})
