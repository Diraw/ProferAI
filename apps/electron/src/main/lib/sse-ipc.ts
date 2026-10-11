import { ipcMain } from 'electron'
import { SSE_IPC_CHANNELS } from '@profer/shared'
import { sseClient, type SSEEvent } from './sse-client'
import { teamNotificationService, type NotificationSettings } from './team-notification-service'
import { getTeamAuth } from './auth-service'

export function registerSseIpc(): void {
  sseClient.onEvent((_workspaceId: string, event: SSEEvent) => {
    teamNotificationService.handleSSEEvent(event)
  })

  const authStatus = getTeamAuth()
  if (authStatus?.teamAccountId) {
    teamNotificationService.setCurrentUserId(authStatus.teamAccountId)
  }

  ipcMain.handle('sse:connect', async (_, workspaceId: string) => {
    const auth = getTeamAuth()
    if (!auth) throw new Error('未登录')
    sseClient.init()
    if (auth.teamAccountId) teamNotificationService.setCurrentUserId(auth.teamAccountId)
    await sseClient.connect(workspaceId, auth.baseUrl, auth.token)
  })

  ipcMain.handle('sse:disconnect', async (_, workspaceId: string) => {
    await sseClient.disconnect(workspaceId)
  })

  ipcMain.handle('sse:disconnect-all', async () => {
    sseClient.disconnectAll()
  })

  ipcMain.handle('team:get-notification-settings', async () => teamNotificationService.getSettings())
  ipcMain.handle('team:update-notification-settings', async (_, settings: Partial<NotificationSettings>) => {
    teamNotificationService.updateSettings(settings)
  })

  void SSE_IPC_CHANNELS
}
