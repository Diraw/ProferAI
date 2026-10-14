import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DESKTOP_NOTIFICATION_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'desktop-notification-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('桌面通知 IPC 注册（结构检查）', () => {
  test('保留通知截断、点击聚焦和回传语义', () => {
    expect(source).toContain('DESKTOP_NOTIFICATION_IPC_CHANNELS.SHOW')
    expect(source).toContain('DESKTOP_NOTIFICATION_IPC_CHANNELS.CLICKED')
    expect(source).toContain('body.slice(0, 200)')
    expect(source).toContain('senderWindow.webContents.send')
    expect(DESKTOP_NOTIFICATION_IPC_CHANNELS.SHOW).toBeDefined()
  })
  test('ipc.ts 只保留注册入口', () => expect(ipc).toContain('registerDesktopNotificationIpc()'))
})
