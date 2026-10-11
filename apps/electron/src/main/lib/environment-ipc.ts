/**
 * 环境检测 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，保留检测结果回写设置的顺序。
 */
import { ipcMain } from 'electron'
import { ENVIRONMENT_IPC_CHANNELS } from '@profer/shared'
import type { EnvironmentCheckResult } from '@profer/shared'
import { checkEnvironment } from './environment-checker'
import { updateSettings } from './settings-service'

export function registerEnvironmentIpc(): void {
  ipcMain.handle(
    ENVIRONMENT_IPC_CHANNELS.CHECK,
    async (): Promise<EnvironmentCheckResult> => {
      const result = await checkEnvironment()
      // 自动保存检测结果到设置
      await updateSettings({
        lastEnvironmentCheck: result,
      })
      return result
    }
  )
}
