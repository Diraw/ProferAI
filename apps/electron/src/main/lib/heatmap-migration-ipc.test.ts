import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 结构性检查：确认搬迁后的热力图与迁移取消注册与原段落等价。
 *
 * 不验证运行时注册：handler 依赖 electron 与文件系统清理，单测中无法安全地完整覆盖。
 * 启动时自动清理仍在 ipc.ts，同样不在本测试范围内。
 */
const source = readFileSync(resolve(import.meta.dir, 'heatmap-migration-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')
const storage = readFileSync(resolve(import.meta.dir, 'storage-ipc.ts'), 'utf8')

describe('热力图与迁移取消 IPC 注册（结构检查）', () => {
  test('注册入口为导出函数，且包含 2 个 ipcMain 注册', () => {
    expect(source).toContain('export function registerHeatmapMigrationIpc(): void')
    expect((source.match(/ipcMain\.(handle|on)\(/g) ?? []).length).toBe(2)
  })

  test('包含热力图通道与迁移取消通道', () => {
    expect(source).toContain('AGENT_IPC_CHANNELS.GET_WORKSPACE_HEATMAP_DAILY')
    expect(source).toContain("'migration:cancelImport'")
  })

  test('动态 import 指向存在的 lib 模块', () => {
    const paths = [...source.matchAll(/await import\('(\.\/[^']+)'\)/g)].map((m) => m[1])
    expect(paths).toEqual(['./workspace-heatmap-query'])
    expect(() => readFileSync(resolve(import.meta.dir, 'workspace-heatmap-query.ts'))).not.toThrow()
  })

  test('ipc.ts 在原位置调用注册函数，且启动清理仍保留在存储模块', () => {
    expect(ipc).toContain('registerHeatmapMigrationIpc()')
    expect(storage).toContain('runStartupCleanup()')
    expect(ipc).not.toContain("'migration:cancelImport', async")
  })
})
