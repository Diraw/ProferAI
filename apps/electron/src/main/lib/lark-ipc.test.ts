import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LARK_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'lark-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Lark IPC 注册（结构检查）', () => {
  test('覆盖 CLI 与 MCP 全部通道', () => {
    for (const key of [
      'GET_STATUS',
      'REFRESH_STATUS',
      'GET_MCP_STATUS',
      'SAVE_MCP_CREDENTIALS',
      'ENABLE_MCP_FOR_WORKSPACE',
      'DISABLE_MCP_FOR_WORKSPACE',
      'START_MCP_LOGIN',
      'CANCEL_MCP_LOGIN',
      'TEST_MCP_CONNECTION',
      'INSTALL_CLI',
      'START_LOGIN',
      'CANCEL_LOGIN',
      'LOGIN_EVENT',
      'MCP_LOGIN_EVENT',
    ] as const) {
      expect(source).toContain(`LARK_IPC_CHANNELS.${key}`)
      expect(LARK_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('保留双登录事件广播和窗口销毁保护', () => {
    expect(source).toContain('__setLarkLoginEventHandler')
    expect(source).toContain('__setLarkMcpLoginEventHandler')
    expect(source).toContain('window.isDestroyed()')
    expect(source).toContain('window.webContents.send')
    expect(source).toContain('getAllWindows')
  })

  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerLarkIpc')
    expect(ipc).toContain('registerLarkIpc()')
    expect(ipc).not.toContain('ipcMain.handle(LARK_IPC_CHANNELS.GET_STATUS')
    expect(ipc).not.toContain('__setLarkLoginEventHandler(')
  })
})
