import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NOTIFICATION_SOUND_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'notification-sound-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('通知音效 IPC 注册（结构检查）', () => {
  test('新模块引用 ADD、REMOVE、GET_URL 三个通道', () => {
    for (const key of ['ADD', 'REMOVE', 'GET_URL'] as const) {
      expect(source).toContain(`NOTIFICATION_SOUND_IPC_CHANNELS.${key}`)
      expect(NOTIFICATION_SOUND_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('保留音效文件复制、配置更新和受控 URL 注册', () => {
    expect(source).toContain('copyFileSync(sourcePath, destPath)')
    expect(source).toContain('updateSettings({ customNotificationSounds: customSounds })')
    expect(source).toContain('registerProferFilePath(filePath)')
    expect(source).toContain('ALLOWED_AUDIO_EXTENSIONS')
  })

  test('删除时保留三类场景引用清理', () => {
    expect(source).toContain("['taskComplete', 'permissionRequest', 'exitPlanMode'] as const")
    expect(source).toContain('updateSettings({ notificationSounds: cleaned })')
  })

  test('注册入口为导出函数 registerNotificationSoundIpc', () => {
    expect(source).toContain('export function registerNotificationSoundIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留通知音效 handler 定义', () => {
    expect(ipc).toContain('registerNotificationSoundIpc()')
    expect(ipc).not.toContain('NOTIFICATION_SOUND_IPC_CHANNELS.ADD,')
    expect(ipc).not.toContain('NOTIFICATION_SOUND_IPC_CHANNELS.GET_URL,')
    expect(ipc).not.toContain('已添加自定义通知音效')
  })
})
