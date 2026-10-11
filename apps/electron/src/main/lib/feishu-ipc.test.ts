import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FEISHU_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'feishu-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Feishu IPC 注册（结构检查）', () => {
  test('覆盖旧 API、多 Bot、绑定、Presence 和扫码注册通道', () => {
    for (const key of [
      'GET_CONFIG',
      'GET_DECRYPTED_SECRET',
      'SAVE_CONFIG',
      'TEST_CONNECTION',
      'START_BRIDGE',
      'STOP_BRIDGE',
      'GET_STATUS',
      'LIST_BINDINGS',
      'UPDATE_BINDING',
      'REMOVE_BINDING',
      'REPORT_PRESENCE',
      'GET_MULTI_CONFIG',
      'SAVE_BOT_CONFIG',
      'REMOVE_BOT',
      'GET_BOT_DECRYPTED_SECRET',
      'START_BOT',
      'STOP_BOT',
      'GET_MULTI_STATUS',
      'REGISTER_APP_START',
      'REGISTER_APP_QRCODE',
      'REGISTER_APP_STATUS',
      'REGISTER_APP_CANCEL',
    ] as const) {
      expect(source).toContain(`FEISHU_IPC_CHANNELS.${key}`)
      expect(FEISHU_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('保留 Bridge 生命周期、绑定查找和扫码 sender/AbortController 语义', () => {
    expect(source).toContain('feishuBridgeManager.startAll()')
    expect(source).toContain('feishuBridgeManager.stopAll()')
    expect(source).toContain('feishuBridgeManager.restartBot(saved.id)')
    expect(source).toContain('feishuBridgeManager.findBridgeByChatId')
    expect(source).toContain('let activeRegisterAbort')
    expect(source).toContain('event.sender.isDestroyed()')
    expect(source).toContain('event.sender.send')
    expect(source).toContain('activeRegisterAbort?.abort()')
  })

  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerFeishuIpc(): void')
    expect(ipc).toContain('registerFeishuIpc()')
    expect(ipc).not.toContain('ipcMain.handle(\n    FEISHU_IPC_CHANNELS.GET_CONFIG')
  })
})
