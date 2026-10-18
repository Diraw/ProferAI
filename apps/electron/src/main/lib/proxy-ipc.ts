/**
 * 代理配置 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，保留配置读写和系统代理检测契约。
 */
import { ipcMain } from 'electron'
import { PROXY_IPC_CHANNELS } from '@profer/shared'
import type { ProxyConfig, SystemProxyDetectResult } from '@profer/shared'
import { getProxySettings, saveProxySettings } from './proxy-settings-service'
import { detectSystemProxy } from './system-proxy-detector'

export function registerProxyIpc(): void {
  ipcMain.handle(
    PROXY_IPC_CHANNELS.GET_SETTINGS,
    async (): Promise<ProxyConfig> => {
      return getProxySettings()
    }
  )

  ipcMain.handle(
    PROXY_IPC_CHANNELS.UPDATE_SETTINGS,
    async (_, config: ProxyConfig): Promise<void> => {
      await saveProxySettings(config)
    }
  )

  ipcMain.handle(
    PROXY_IPC_CHANNELS.DETECT_SYSTEM,
    async (): Promise<SystemProxyDetectResult> => {
      return detectSystemProxy()
    }
  )
}
