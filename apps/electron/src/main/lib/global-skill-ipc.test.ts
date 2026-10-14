import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GLOBAL_SKILL_IPC_CHANNELS, SKILL_MASTER_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'global-skill-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Global/Master Skill IPC 注册（结构检查）', () => {
  test('覆盖全局 Skill 与旧 Master Skill 全部通道', () => {
    for (const key of ['LIST', 'READ', 'READ_WORKSPACE_COPY', 'SAVE_WORKSPACE_COPY', 'SAVE', 'COPY_TO_USER', 'CREATE_USER', 'COPY_TO_WORKSPACE', 'GET_DELETE_BLOCKERS', 'DELETE_USER', 'SET_ENABLED', 'RESTORE', 'GET_OVERRIDES'] as const) {
      expect(source).toContain(`GLOBAL_SKILL_IPC_CHANNELS.${key}`)
      expect(GLOBAL_SKILL_IPC_CHANNELS[key]).toBeDefined()
    }
    for (const key of ['LIST', 'READ', 'SAVE', 'RENAME_META', 'LIST_HISTORY', 'ROLLBACK', 'SYNC_TO_WORKSPACES', 'DETECT_CONFLICT'] as const) {
      expect(source).toContain(`SKILL_MASTER_IPC_CHANNELS.${key}`)
      expect(SKILL_MASTER_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('保留 scope/路径安全校验和旧 Master 写入禁用语义', () => {
    expect(source).toContain('assertSafeSkillSegment')
    expect(source).toContain("scope !== 'global' && scope !== 'workspace'")
    expect(source).toContain('旧元 Skill 写接口已停用')
    expect(source).toContain('旧元 Skill 同步接口已停用')
  })

  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerGlobalSkillIpc(): void')
    expect(ipc).toContain('registerGlobalSkillIpc()')
    expect(ipc).not.toContain('ipcMain.handle(GLOBAL_SKILL_IPC_CHANNELS.LIST,')
    expect(ipc).not.toContain('ipcMain.handle(SKILL_MASTER_IPC_CHANNELS.LIST,')
  })
})
