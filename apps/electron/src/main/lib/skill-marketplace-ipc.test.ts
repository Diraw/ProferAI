import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SKILL_MARKETPLACE_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'skill-marketplace-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Skill Marketplace IPC 注册（结构检查）', () => {
  test('覆盖发布、取消发布、列表、安装和更新检查通道', () => {
    for (const key of ['PUBLISH', 'UNPUBLISH', 'LIST_TEAM_SKILLS', 'INSTALL_TEAM_SKILL', 'CHECK_FOR_UPDATES'] as const) {
      expect(source).toContain(`SKILL_MARKETPLACE_IPC_CHANNELS.${key}`)
      expect(SKILL_MARKETPLACE_IPC_CHANNELS[key]).toBeDefined()
    }
  })
  test('保留本地写入、团队文件、同步队列和版本比较语义', () => {
    expect(source).toContain('uploadFile')
    expect(source).toContain('downloadFile')
    expect(source).toContain('deleteRemoteFile')
    expect(source).toContain('enqueueChange')
    expect(source).toContain('scanSkillsInDir(targetDir, true)')
    expect(source).toContain('compareVersions')
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerSkillMarketplaceIpc(): void')
    expect(ipc).toContain('registerSkillMarketplaceIpc()')
    expect(ipc).not.toContain('ipcMain.handle(\n    SKILL_MARKETPLACE_IPC_CHANNELS.PUBLISH')
  })
})
