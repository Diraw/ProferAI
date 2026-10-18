import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AUTOMATION_IPC_CHANNELS, RECOMMENDATION_IPC_CHANNELS } from '@profer/shared'

/**
 * 结构性检查：确认搬迁后的注册模块包含原段落的全部通道引用。
 *
 * 注意：这里**不**验证运行时注册。尝试用 mock.module('electron') 捕获 ipcMain 调用时，
 * 依赖链上的 electron 导出无法被完整覆盖，registerAutomationIpc 的 ipcMain 调用没有被记录。
 * 运行时注册行为目前未被自动化测试覆盖，需要用真实应用启动验证。
 */
const source = readFileSync(resolve(import.meta.dir, 'automation-ipc.ts'), 'utf8')

describe('定时任务与推荐 IPC 注册（结构检查）', () => {
  test('新模块引用全部 5 个 automation 通道与 3 个 recommendation 通道', () => {
    for (const key of ['LIST', 'CREATE', 'UPDATE', 'DELETE', 'TOGGLE', 'RUN_NOW'] as const) {
      expect(source).toContain(`AUTOMATION_IPC_CHANNELS.${key}`)
      expect(AUTOMATION_IPC_CHANNELS[key]).toBeDefined()
    }
    for (const key of ['LIST', 'REFRESH', 'FEEDBACK'] as const) {
      expect(source).toContain(`RECOMMENDATION_IPC_CHANNELS.${key}`)
      expect(RECOMMENDATION_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('注册入口为导出函数 registerAutomationIpc', () => {
    expect(source).toContain('export function registerAutomationIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留原段落的 handler 定义', () => {
    const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')
    expect(ipc).toContain('registerAutomationIpc()')
    expect(ipc).not.toContain('AUTOMATION_IPC_CHANNELS.CREATE,')
  })
})
