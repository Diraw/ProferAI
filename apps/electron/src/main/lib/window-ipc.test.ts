import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'window-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('窗口 IPC 注册（结构检查）', () => {
  test('覆盖窗口控制通道并使用调用方窗口', () => {
    for (const key of ['WINDOW_MINIMIZE', 'WINDOW_MAXIMIZE', 'WINDOW_CLOSE', 'WINDOW_IS_MAXIMIZED', 'WINDOW_IS_FULL_SCREEN'] as const) expect(source).toContain(`IPC_CHANNELS.${key}`)
    expect(source).toContain('BrowserWindow.fromWebContents(event.sender)')
    expect(IPC_CHANNELS.WINDOW_MINIMIZE).toBeDefined()
  })
  test('ipc.ts 只保留注册入口', () => expect(ipc).toContain('registerWindowIpc()'))
})
