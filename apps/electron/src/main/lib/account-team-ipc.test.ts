import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AUTH_IPC_CHANNELS, SYNC_IPC_CHANNELS, TEAM_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'account-team-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('身份认证/同步/团队 IPC 注册（结构检查）', () => {
  test('覆盖 Auth、Sync、Team 通道', () => {
    for (const key of ['GET_DEVICE_IDENTITY', 'GET_USER_IDENTITY', 'UPDATE_PROFILE', 'LOGIN', 'LOGOUT', 'GET_AUTH_STATUS', 'REGISTER', 'GET_SERVER_INFO', 'GET_TEAM_AUTH', 'LIST_DEVICES', 'REVOKE_DEVICE', 'GET_REGISTRATION_OPTIONS', 'SEND_REGISTRATION_OTP', 'VERIFY_REGISTRATION_OTP'] as const) {
      expect(source).toContain(`AUTH_IPC_CHANNELS.${key}`)
      expect(AUTH_IPC_CHANNELS[key]).toBeDefined()
    }
    for (const key of ['GET_STATUS', 'TRIGGER_SYNC', 'GET_PENDING_CHANGES', 'DISCARD_PENDING_CHANGES'] as const) {
      expect(source).toContain(`SYNC_IPC_CHANNELS.${key}`)
      expect(SYNC_IPC_CHANNELS[key]).toBeDefined()
    }
    for (const key of ['LIST_WORKSPACES', 'CREATE_WORKSPACE', 'DELETE_WORKSPACE', 'GET_MEMBERS', 'CREATE_INVITATION', 'LIST_INVITATIONS', 'CANCEL_INVITATION', 'GET_STATS', 'VERIFY_INVITATION', 'ACCEPT_INVITATION', 'DECLINE_INVITATION', 'UPDATE_MEMBER_ROLE', 'REMOVE_MEMBER', 'LEAVE_WORKSPACE', 'TRANSFER_OWNERSHIP', 'RESTORE_WORKSPACE'] as const) {
      expect(source).toContain(`TEAM_IPC_CHANNELS.${key}`)
      expect(TEAM_IPC_CHANNELS[key]).toBeDefined()
    }
  })
  test('保留登录/注册启动同步和侧栏同步回调', () => {
    expect(source).toContain('startSyncEngine()')
    expect(source).toContain('await syncSidebar()')
    expect(source).toContain("'team:workspaces-synced'")
    expect(source).toContain("'team:get-audit-logs'")
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerAccountTeamIpc')
    expect(ipc).toContain('registerAccountTeamIpc()')
    expect(ipc).not.toContain('ipcMain.handle(\n    AUTH_IPC_CHANNELS.LOGIN')
    expect(ipc).not.toContain('ipcMain.handle(\n    TEAM_IPC_CHANNELS.LIST_WORKSPACES')
  })
})
