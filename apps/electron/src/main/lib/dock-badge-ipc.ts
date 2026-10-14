/**
 * Dock/Launcher 角标 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致。
 */
import { ipcMain } from 'electron'
import { DOCK_BADGE_IPC_CHANNELS } from '../../types'
import { setDockBadgeCount } from './dock-badge-service'

export function registerDockBadgeIpc(): void {
  ipcMain.handle(
    DOCK_BADGE_IPC_CHANNELS.SET_COUNT,
    async (_, count: number): Promise<boolean> => {
      return setDockBadgeCount(count)
    }
  )
}
