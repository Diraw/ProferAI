import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QUICK_TASK_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'quick-task-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('快速任务 IPC 注册（结构检查）', () => {
  test('覆盖三个通道和主窗口转发', () => {
    for (const key of ['SUBMIT', 'HIDE', 'REREGISTER_GLOBAL_SHORTCUTS'] as const) expect(source).toContain(`QUICK_TASK_IPC_CHANNELS.${key}`)
    expect(source).toContain("'quick-task:open-session'")
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(ipc).toContain('registerQuickTaskIpc()')
    expect(ipc).not.toContain('ipcMain.handle(QUICK_TASK_IPC_CHANNELS.SUBMIT')
  })
})
