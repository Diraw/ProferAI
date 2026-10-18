/**
 * 自定义通知音效 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致：
 * 由 registerIpcHandlers 在通知音效段原位置调用 registerNotificationSoundIpc()。
 */
import { ipcMain } from 'electron'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { NOTIFICATION_SOUND_IPC_CHANNELS, type CustomNotificationSound } from '../../types'
import { registerProferFilePath } from './local-file-protocol'
import { getCustomSoundsDir } from './config-paths'
import { getSettings, updateSettings } from './settings-service'

/** 允许的音频文件扩展名。 */
const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.webm'])

export function registerNotificationSoundIpc(): void {
  // 添加自定义音效
  ipcMain.handle(
    NOTIFICATION_SOUND_IPC_CHANNELS.ADD,
    async (_, sourcePath: string, label: string): Promise<CustomNotificationSound> => {
      const ext = extname(sourcePath).toLowerCase()
      if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
        throw new Error(`不支持的音频格式: ${ext}。支持: mp3, wav, ogg, aac, m4a, flac, webm`)
      }
      if (!existsSync(sourcePath)) {
        throw new Error('源文件不存在')
      }

      const soundsDir = getCustomSoundsDir()
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const fileName = `${randomUUID()}${ext}`
      const destPath = join(soundsDir, fileName)

      copyFileSync(sourcePath, destPath)

      const sound: CustomNotificationSound = {
        id,
        label: label.trim() || `自定义音效 ${new Date().toLocaleDateString()}`,
        fileName,
        addedAt: Date.now(),
      }

      const settings = getSettings()
      const customSounds = [...(settings.customNotificationSounds ?? []), sound]
      updateSettings({ customNotificationSounds: customSounds })

      console.log(`[IPC] 已添加自定义通知音效: ${label} → ${fileName}`)
      return sound
    }
  )

  // 删除自定义音效
  ipcMain.handle(
    NOTIFICATION_SOUND_IPC_CHANNELS.REMOVE,
    async (_, id: string): Promise<CustomNotificationSound[]> => {
      const settings = getSettings()
      const currentSounds = settings.customNotificationSounds ?? []
      const target = currentSounds.find((s) => s.id === id)
      if (!target) return currentSounds

      // 删除文件
      const soundsDir = getCustomSoundsDir()
      const filePath = join(soundsDir, target.fileName)
      try {
        if (existsSync(filePath)) rmSync(filePath)
      } catch (err) {
        console.warn(`[IPC] 删除自定义音效文件失败: ${filePath}`, err)
      }

      // 从 settings 中移除
      const updated = currentSounds.filter((s) => s.id !== id)
      updateSettings({ customNotificationSounds: updated })

      // 清理各场景中被删除音效的引用
      if (settings.notificationSounds) {
        const cleaned: typeof settings.notificationSounds = { ...settings.notificationSounds }
        let needsClean = false
        for (const key of ['taskComplete', 'permissionRequest', 'exitPlanMode'] as const) {
          if (cleaned[key] === id) {
            cleaned[key] = undefined
            needsClean = true
          }
        }
        if (needsClean) updateSettings({ notificationSounds: cleaned })
      }

      console.log(`[IPC] 已删除自定义通知音效: ${target.label} (${id})`)
      return updated
    }
  )

  // 获取自定义音效的文件 URL（使用 profer-file:// 协议，renderer 可安全加载）
  ipcMain.handle(
    NOTIFICATION_SOUND_IPC_CHANNELS.GET_URL,
    async (_, fileName: string): Promise<string> => {
      const soundsDir = getCustomSoundsDir()
      const filePath = join(soundsDir, fileName)
      if (!existsSync(filePath)) {
        throw new Error(`音效文件不存在: ${fileName}`)
      }
      const url = registerProferFilePath(filePath)
      console.log(`[IPC] 自定义音效 URL: ${filePath} → ${url}`)
      return url
    }
  )
}
