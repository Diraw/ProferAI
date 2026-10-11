import { BrowserWindow, ipcMain } from 'electron'
import { AUTH_IPC_CHANNELS, SYNC_IPC_CHANNELS, TEAM_IPC_CHANNELS } from '@profer/shared'
import {
  getOrCreateDeviceIdentity,
  getUserIdentity,
} from './identity-service'
import {
  login,
  register,
  logout,
  getAuthStatus,
  getServerInfoList,
  getTeamAuth,
  getTeamAuthWithRefresh,
  listRemoteDevices,
  revokeRemoteDevice,
  getRegistrationOptions,
  sendRegistrationOtp,
  verifyRegistrationOtp,
} from './auth-service'
import {
  startSyncEngine,
  getSyncStatus,
  triggerSync,
  getPendingChanges,
  discardPendingChanges,
} from './sync-manager'
import {
  listTeamWorkspaces,
  createTeamWorkspace,
  deleteTeamWorkspace,
  getMembers,
  createInvitation,
  verifyInvitation,
  acceptInvitation,
  declineInvitation,
  listInvitations,
  cancelInvitation,
  getWorkspaceStats,
  updateMemberRole,
  removeMember,
  leaveWorkspace,
  transferOwnership,
  restoreTeamWorkspace,
  getAnnouncements,
  createAnnouncement,
  deleteAnnouncement,
} from './team-manager'
import { syncTeamWorkspacesToIndex } from './agent-workspace-manager'

export interface AccountTeamIpcContext {
  syncTeamWorkspacesToSidebar?: () => Promise<void>
}

async function syncTeamWorkspacesToSidebar(): Promise<void> {
  try {
    const teamWorkspaces = await listTeamWorkspaces()
    syncTeamWorkspacesToIndex(teamWorkspaces)
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('team:workspaces-synced')
    }
  } catch (error) {
    console.error('[IPC] 同步团队工作区失败:', error)
  }
}

export function registerAccountTeamIpc(context: AccountTeamIpcContext = {}): void {
  const syncSidebar = context.syncTeamWorkspacesToSidebar ?? syncTeamWorkspacesToSidebar

  ipcMain.handle(AUTH_IPC_CHANNELS.GET_DEVICE_IDENTITY, async () => getOrCreateDeviceIdentity())
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_USER_IDENTITY, async () => getUserIdentity())
  ipcMain.handle(AUTH_IPC_CHANNELS.UPDATE_PROFILE, async (_, _updates: Record<string, unknown>) => getUserIdentity())

  ipcMain.handle(AUTH_IPC_CHANNELS.LOGIN, async (_, credentials: { email: string; password: string; revokeSlotId?: string }) => {
    const result = await login(credentials.email, credentials.password, credentials.revokeSlotId)
    console.log('[AUTH IPC] login result:', JSON.stringify({ success: result.success, teamAccountId: result.teamAccountId, teamEmail: result.teamEmail }))
    if (result.success) {
      startSyncEngine()
      await syncSidebar()
    }
    return result
  })
  ipcMain.handle(AUTH_IPC_CHANNELS.LOGOUT, async () => logout())
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_SERVER_INFO, async () => getServerInfoList())
  ipcMain.handle(AUTH_IPC_CHANNELS.REGISTER, async (_, credentials: { email: string; password: string; displayName: string; inviteCode?: string; otpToken?: string; emailOtp?: string }) => {
    const result = await register(credentials.email, credentials.password, credentials.displayName, credentials.inviteCode, undefined, undefined, credentials.otpToken, credentials.emailOtp)
    if (result.success) {
      startSyncEngine()
      await syncSidebar()
    }
    return result
  })
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_REGISTRATION_OPTIONS, async () => getRegistrationOptions())
  ipcMain.handle(AUTH_IPC_CHANNELS.SEND_REGISTRATION_OTP, async (_, email: string) => sendRegistrationOtp(email))
  ipcMain.handle(AUTH_IPC_CHANNELS.VERIFY_REGISTRATION_OTP, async (_, email: string, otpToken: string, code: string) => verifyRegistrationOtp(email, otpToken, code))
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_AUTH_STATUS, async () => getAuthStatus())
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_TEAM_AUTH, async () => getTeamAuthWithRefresh())
  ipcMain.handle(AUTH_IPC_CHANNELS.LIST_DEVICES, async () => listRemoteDevices())
  ipcMain.handle(AUTH_IPC_CHANNELS.REVOKE_DEVICE, async (_, slotId: string) => revokeRemoteDevice(slotId))

  ipcMain.handle(SYNC_IPC_CHANNELS.GET_STATUS, async () => getSyncStatus())
  ipcMain.handle(SYNC_IPC_CHANNELS.TRIGGER_SYNC, async (_, workspaceId: string) => triggerSync(workspaceId))
  ipcMain.handle(SYNC_IPC_CHANNELS.GET_PENDING_CHANGES, async (_, workspaceId: string) => getPendingChanges(workspaceId))
  ipcMain.handle(SYNC_IPC_CHANNELS.DISCARD_PENDING_CHANGES, async (_, workspaceId: string) => discardPendingChanges(workspaceId))

  ipcMain.handle(TEAM_IPC_CHANNELS.LIST_WORKSPACES, async () => listTeamWorkspaces())
  ipcMain.handle(TEAM_IPC_CHANNELS.CREATE_WORKSPACE, async (_, name: string) => {
    const result = await createTeamWorkspace(name)
    void syncSidebar()
    return result
  })
  ipcMain.handle(TEAM_IPC_CHANNELS.DELETE_WORKSPACE, async (_, workspaceId: string) => deleteTeamWorkspace(workspaceId))
  ipcMain.handle(TEAM_IPC_CHANNELS.GET_MEMBERS, async (_, workspaceId: string) => getMembers(workspaceId))
  ipcMain.handle(TEAM_IPC_CHANNELS.CREATE_INVITATION, async (_, input: { workspaceId: string; email: string; role: string }) => createInvitation(input))
  ipcMain.handle(TEAM_IPC_CHANNELS.LIST_INVITATIONS, async (_, workspaceId: string) => listInvitations(workspaceId))
  ipcMain.handle(TEAM_IPC_CHANNELS.CANCEL_INVITATION, async (_, input: { workspaceId: string; invitationId: string }) => cancelInvitation(input.workspaceId, input.invitationId))
  ipcMain.handle('team:get-announcements', async (_, workspaceId: string) => getAnnouncements(workspaceId))
  ipcMain.handle('team:create-announcement', async (_, workspaceId: string, title: string, content: string, isPinned: boolean) => createAnnouncement(workspaceId, title, content, isPinned))
  ipcMain.handle('team:delete-announcement', async (_, workspaceId: string, announcementId: string) => deleteAnnouncement(workspaceId, announcementId))
  ipcMain.handle(TEAM_IPC_CHANNELS.GET_STATS, async (_, workspaceId: string) => getWorkspaceStats(workspaceId))
  ipcMain.handle('team:get-audit-logs', async (_, workspaceId: string, limit?: number, before?: number) => {
    const auth = getTeamAuth()
    if (!auth) throw new Error('未登录')
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    const response = await (require('undici').fetch as typeof fetch)(`${auth.baseUrl}/v1/workspaces/${workspaceId}/audit-logs?${params.toString()}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!response.ok) return []
    const data = await response.json()
    if (before && Array.isArray(data)) return data.filter((entry: { created_at: number }) => entry.created_at < before)
    return Array.isArray(data) ? data : []
  })
  ipcMain.handle(TEAM_IPC_CHANNELS.VERIFY_INVITATION, async (_, token: string) => verifyInvitation(token))
  ipcMain.handle(TEAM_IPC_CHANNELS.ACCEPT_INVITATION, async (_, token: string) => {
    const result = await acceptInvitation(token)
    void syncSidebar()
    return result
  })
  ipcMain.handle(TEAM_IPC_CHANNELS.DECLINE_INVITATION, async (_, token: string) => declineInvitation(token))
  ipcMain.handle(TEAM_IPC_CHANNELS.UPDATE_MEMBER_ROLE, async (_, input: { workspaceId: string; userId: string; role: string }) => updateMemberRole(input.workspaceId, input.userId, input.role))
  ipcMain.handle(TEAM_IPC_CHANNELS.REMOVE_MEMBER, async (_, input: { workspaceId: string; userId: string }) => removeMember(input.workspaceId, input.userId))
  ipcMain.handle(TEAM_IPC_CHANNELS.LEAVE_WORKSPACE, async (_, workspaceId: string) => leaveWorkspace(workspaceId))
  ipcMain.handle(TEAM_IPC_CHANNELS.TRANSFER_OWNERSHIP, async (_, input: { workspaceId: string; targetUserId: string }) => transferOwnership(input.workspaceId, input.targetUserId))
  ipcMain.handle(TEAM_IPC_CHANNELS.RESTORE_WORKSPACE, async (_, workspaceId: string) => {
    await restoreTeamWorkspace(workspaceId)
    void syncSidebar()
  })
}
