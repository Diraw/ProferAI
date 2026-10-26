import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 结构性检查：确认搬迁后的应用设置注册模块与原段落等价。
 *
 * 注意：这里**不**验证运行时注册。应用设置的 handler 依赖 BrowserWindow、nativeTheme 与动态 import，
 * 无法在单测中完整覆盖；运行时行为需要真实应用启动验证。
 */
const source = readFileSync(resolve(import.meta.dir, 'settings-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('应用设置 IPC 注册（结构检查）', () => {
  test('注册入口为导出函数 registerSettingsIpc', () => {
    expect(source).toContain('export function registerSettingsIpc(): void')
  })

  test('包含原段落的 ipcMain 注册（允许后续新增）', () => {
    // 只验证「搬过来的那一段还在」，不锁死精确条数：新增一个 handler 就会让
    // toBe(10) 这种断言变红，而它并不代表搬迁回归（v0.16.14 的远程公网地址就新增了一个）。
    const count = (source.match(/ipcMain\.(handle|on)\(/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(10)
  })

  test('动态 import 路径已改为相对 lib/，且目标文件存在', () => {
    const paths = [...source.matchAll(/await import\('(\.\/[^']+)'\)/g)].map((m) => m[1])
    expect(paths).toEqual(['./quick-task-window', './global-shortcut-service'])
    for (const relative of paths) {
      const target = resolve(import.meta.dir, `${relative}.ts`)
      expect(() => readFileSync(target)).not.toThrow()
    }
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留原段落的 handler 定义', () => {
    expect(ipc).toContain('registerSettingsIpc()')
    expect(ipc).not.toContain('SETTINGS_IPC_CHANNELS.GET_POCKET_MODE_STATUS,')
  })
})
