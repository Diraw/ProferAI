import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TEAM_FILE_IPC_CHANNELS, TEAM_MEMORY_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'team-content-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Team Files/Memory IPC 注册（结构检查）', () => {
  test('覆盖团队文件与团队记忆通道', () => {
    for (const key of [
      'CREATE_DIRECTORY', 'UPLOAD', 'DOWNLOAD', 'DELETE', 'GET_MANIFEST', 'MOVE', 'RENAME', 'SEARCH',
      'GET_METADATA', 'PATCH_METADATA', 'GET_TAGS', 'GET_STATUSES', 'SET_PREFERENCE', 'GET_ACTIVITIES',
      'LIST_TRASH', 'RESTORE_TRASH', 'PURGE_TRASH',
    ] as const) {
      expect(source).toContain(`TEAM_FILE_IPC_CHANNELS.${key}`)
      expect(TEAM_FILE_IPC_CHANNELS[key]).toBeDefined()
    }
    for (const key of ['LIST', 'READ', 'CREATE', 'UPDATE', 'LIST_REVISIONS', 'ARCHIVE', 'UNARCHIVE'] as const) {
      expect(source).toContain(`TEAM_MEMORY_IPC_CHANNELS.${key}`)
      expect(TEAM_MEMORY_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('只对原有敏感 Team Memory 写操作执行 sender guard', () => {
    expect(source).toContain('export interface TeamContentIpcContext')
    expect(source).toContain('const { assertSensitiveAgentIpcSender } = context')
    for (const key of ['CREATE', 'UPDATE', 'ARCHIVE', 'UNARCHIVE'] as const) {
      const channel = `TEAM_MEMORY_IPC_CHANNELS.${key}`
      const start = source.indexOf(`ipcMain.handle(${channel}`)
      const end = source.indexOf('\n  ipcMain.handle(', start + 1)
      expect(source.slice(start, end < 0 ? source.length : end)).toContain('assertSensitiveAgentIpcSender(event)')
    }
    for (const key of ['LIST', 'READ', 'LIST_REVISIONS'] as const) {
      const channel = `TEAM_MEMORY_IPC_CHANNELS.${key}`
      const line = source.split('\n').find((entry) => entry.includes(`ipcMain.handle(${channel}`))
      expect(line).toBeDefined()
      expect(line).not.toContain('assertSensitiveAgentIpcSender')
    }
  })

  test('ipc.ts 只保留原位置注册入口', () => {
    expect(source).toContain('export function registerTeamContentIpc')
    expect(ipc).toContain('registerTeamContentIpc({ assertSensitiveAgentIpcSender })')
    expect(ipc).not.toContain('ipcMain.handle(\n    TEAM_FILE_IPC_CHANNELS.CREATE_DIRECTORY')
    expect(ipc).not.toContain('ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.LIST,')
  })
})
