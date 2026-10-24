/**
 * 应用设置（Settings）的 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致：
 * 由 registerIpcHandlers 在原位置调用 registerSettingsIpc()。
 * 段内的动态 import 路径已改为相对 lib/ 的路径（原路径相对 src/main/）。
 */
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { SETTINGS_IPC_CHANNELS, type AppSettings } from '../../types'
import { getSettings, updateSettings } from './settings-service'
import { getRemoteServiceStatus, setRemoteServiceEnabled, restartRemoteService } from './remote-service'
import { updateWindowFrameAppearance } from './titlebar-overlay'
import { syncFeishuSyncSleepBlocker } from './feishu-sleep-blocker'

export function registerSettingsIpc(): void {

  // 获取应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET,
    async (): Promise<AppSettings> => {
      return getSettings()
    }
  )

  // 更新应用设置
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.UPDATE,
    async (event, updates: Partial<AppSettings>): Promise<AppSettings> => {
      const result = await updateSettings(updates)

      // 快速任务开关变化：实时创建/销毁预创建窗口，并重新注册全局快捷键
      if (updates.quickTaskEnabled !== undefined) {
        const { createQuickTaskWindow, destroyQuickTaskWindow } = await import('./quick-task-window')
        if (updates.quickTaskEnabled === true) {
          createQuickTaskWindow()
        } else {
          destroyQuickTaskWindow()
        }
        const { reregisterAllGlobalShortcuts } = await import('./global-shortcut-service')
        reregisterAllGlobalShortcuts()
      }

      if (updates.feishuSessionMirror !== undefined) {
        syncFeishuSyncSleepBlocker(result)
      }

      if (updates.developerModeEnabled !== undefined || updates.pluginSystemEnabled !== undefined) {
        const payload = {
          developerModeEnabled: result.developerModeEnabled === true,
        }
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send(SETTINGS_IPC_CHANNELS.ON_DEVELOPER_SETTINGS_CHANGED, payload)
        })
      }

      // 主题相关设置变化时，广播给所有窗口（跨窗口同步，如 Quick Task 面板）
      if (updates.themeMode !== undefined || updates.themeStyle !== undefined || updates.interfaceVariant !== undefined) {
        const payload = {
          themeMode: result.themeMode,
          themeStyle: result.themeStyle,
          interfaceVariant: result.interfaceVariant,
        }
        BrowserWindow.getAllWindows().forEach((win) => {
          updateWindowFrameAppearance(win)
          // 跳过发起者窗口，避免重复应用
          if (win.webContents.id !== event.sender.id) {
            win.webContents.send(SETTINGS_IPC_CHANNELS.ON_THEME_SETTINGS_CHANGED, payload)
          }
        })
      }

      return result
    }
  )

  // 获取移动模式服务状态。Token 只在服务实际监听后随状态返回。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_POCKET_MODE_STATUS,
    async () => getRemoteServiceStatus(),
  )

  // 设置移动模式（试验版）。开启后立即监听局域网，关闭后立即断开。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.SET_POCKET_MODE_ENABLED,
    async (_event, enabled: boolean) => {
      if (typeof enabled !== 'boolean') throw new Error('移动模式开关参数无效')
      if (!enabled) {
        const status = await setRemoteServiceEnabled(false)
        updateSettings({ pocketModeEnabled: false })
        return status
      }

      const status = await setRemoteServiceEnabled(true)
      updateSettings({ pocketModeEnabled: true })
      return status
    },
  )

  // 设置移动模式服务端口：保存并热应用（服务运行中自动重启）。
  // port=0 表示恢复默认端口（清除自定义值，回到正式版 7788 / 开发版 7789）。
  // 端口占用或非法时服务可能启动失败，状态由 UI 轮询刷新呈现。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.SET_POCKET_MODE_PORT,
    async (_event, port: unknown) => {
      const n = typeof port === 'number' ? port : Number(port)
      if (n === 0) {
        updateSettings({ pocketModePort: 0 })
        return restartRemoteService()
      }
      if (!Number.isInteger(n) || n < 1024 || n > 65535) {
        throw new Error('端口必须是 1024-65535 之间的整数')
      }
      updateSettings({ pocketModePort: n })
      // 服务运行中则停掉旧端口并重启；未运行时新端口在下次启动时生效。
      return restartRemoteService()
    },
  )

  // 获取安卓版 APK 扫码下载信息（地址 + 二维码 + 文件名）。
  // 直接指向官网稳定域名 https://profer.cn/profer-mobile/，不依赖移动模式服务是否运行。
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_APK_QR,
    async (): Promise<{ url: string; dataUrl: string; fileName: string }> => {
      const url = 'https://profer.cn/profer-mobile/Profer-移动版-android.apk'
      const fileName = 'Profer-移动版-android.apk'
      try {
        const QRCode = (await import('qrcode')).default
        const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
        return { url, dataUrl, fileName }
      } catch (err) {
        console.error('[移动模式] APK 二维码生成失败:', err)
        return { url, dataUrl: '', fileName }
      }
    },
  )

  // 同步更新应用设置（用于 beforeunload 场景）
  ipcMain.on(
    SETTINGS_IPC_CHANNELS.UPDATE_SYNC,
    (event, updates: Partial<AppSettings>) => {
      try {
        const result = updateSettings(updates)
        if (updates.feishuSessionMirror !== undefined) {
          syncFeishuSyncSleepBlocker(result)
        }
        if (updates.developerModeEnabled !== undefined || updates.pluginSystemEnabled !== undefined) {
          const payload = {
            developerModeEnabled: result.developerModeEnabled === true,
          }
          BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send(SETTINGS_IPC_CHANNELS.ON_DEVELOPER_SETTINGS_CHANGED, payload)
          })
        }
        event.returnValue = true
      } catch {
        event.returnValue = false
      }
    }
  )

  // 获取系统主题（是否深色模式）
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_SYSTEM_THEME,
    async (): Promise<boolean> => {
      return nativeTheme.shouldUseDarkColors
    }
  )

  // 获取开机自启动状态
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.GET_AUTO_LAUNCH,
    async (): Promise<boolean> => {
      return app.getLoginItemSettings().openAtLogin
    }
  )

  // 设置开机自启动
  ipcMain.handle(
    SETTINGS_IPC_CHANNELS.SET_AUTO_LAUNCH,
    async (_event, enabled: boolean): Promise<void> => {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        // 开发模式下也允许设置，方便测试（正式版会自动使用应用路径）
        ...(app.isPackaged ? {} : { openAtLogin: enabled, path: process.execPath }),
      })
      // 同步持久化到 settings.json
      updateSettings({ autoLaunch: enabled })
      console.log(`[设置] 开机自启动: ${enabled ? '已开启' : '已关闭'}`)
    }
  )

  // 监听系统主题变化，推送给所有渲染进程窗口
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    console.log(`[设置] 系统主题变化: ${isDark ? '深色' : '浅色'}`)
    BrowserWindow.getAllWindows().forEach((win) => {
      updateWindowFrameAppearance(win)
      win.webContents.send(SETTINGS_IPC_CHANNELS.ON_SYSTEM_THEME_CHANGED, isDark)
    })
  })
}
