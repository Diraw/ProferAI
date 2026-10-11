/**
 * 用户档案 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致：
 * 由 registerIpcHandlers 在用户档案段原位置调用 registerUserProfileIpc()。
 */
import { ipcMain } from 'electron'
import type { UserProfile } from '../../types'
import { USER_PROFILE_IPC_CHANNELS } from '../../types'
import { getUserProfile, updateUserProfile } from './user-profile-service'

export function registerUserProfileIpc(): void {
  // 获取用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.GET,
    async (): Promise<UserProfile> => {
      return getUserProfile()
    }
  )

  // 更新用户档案
  ipcMain.handle(
    USER_PROFILE_IPC_CHANNELS.UPDATE,
    async (_, updates: Partial<UserProfile>): Promise<UserProfile> => {
      return updateUserProfile(updates)
    }
  )
}
