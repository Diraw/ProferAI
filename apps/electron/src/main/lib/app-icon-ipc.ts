/**
 * 应用图标 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致。
 */
import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { APP_ICON_IPC_CHANNELS } from '../../types'
import { updateSettings } from './settings-service'
import { resolveAppIconPath } from './app-icon-service'

export { resolveAppIconPath } from './app-icon-service'

export function registerAppIconIpc(): void {
  ipcMain.handle(
    APP_ICON_IPC_CHANNELS.SET,
    async (_, variantId: string): Promise<boolean> => {
      try {
        // 解析图标文件路径
        const iconPath = resolveAppIconPath(variantId)
        if (!iconPath || !existsSync(iconPath)) {
          console.warn('[图标] 图标文件不存在:', iconPath)
          return false
        }

        // macOS: 设置 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.setIcon(iconPath)
        }

        // 持久化到设置
        await updateSettings({ appIconVariant: variantId })
        console.log(`[图标] 已切换到: ${variantId}`)
        return true
      } catch (error) {
        console.error('[图标] 切换失败:', error)
        return false
      }
    }
  )
}
