import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, 'sse-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('SSE IPC 注册（结构检查）', () => {
  test('覆盖连接生命周期和通知设置', () => {
    for (const channel of ['sse:connect', 'sse:disconnect', 'sse:disconnect-all', 'team:get-notification-settings', 'team:update-notification-settings']) expect(source).toContain(channel)
    expect(source).toContain('sseClient.onEvent')
    expect(source).toContain('teamNotificationService.handleSSEEvent')
    expect(source).toContain('sseClient.init()')
    expect(source).toContain('sseClient.disconnectAll()')
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerSseIpc(): void')
    expect(ipc).toContain('registerSseIpc()')
    expect(ipc).not.toContain("ipcMain.handle('sse:connect'")
  })
})
