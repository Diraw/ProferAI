import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CHANNEL_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'channel-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('渠道 IPC 注册（结构检查）', () => {
  test('覆盖渠道列表、配置、测试、同步和 OAuth 通道', () => {
    for (const key of ['LIST', 'GET_OFFICIAL_HEALTH', 'CREATE', 'UPDATE', 'DELETE', 'DECRYPT_KEY', 'TEST', 'TEST_DIRECT', 'FETCH_MODELS', 'CANCEL_REQUEST', 'GET_PLAN_QUOTA', 'SYNC_FROM_SERVER', 'GET_COMMERCIAL_MODE', 'GET_ACCOUNT_CAPABILITIES', 'GET_BUILD_TARGET', 'XAI_LOGIN', 'XAI_LOGIN_CANCEL', 'XAI_MODELS', 'CODEX_LOGIN', 'CODEX_LOGIN_CANCEL', 'CODEX_MODELS'] as const) {
      expect(source).toContain(`CHANNEL_IPC_CHANNELS.${key}`)
      expect(CHANNEL_IPC_CHANNELS[key]).toBeDefined()
    }
  })
  test('保留窗口级请求取消和目录失效广播', () => {
    expect(source).toContain('context.channelNetworkRequests.run(event.sender')
    expect(source).toContain('context.channelNetworkRequests.cancel(event.sender.id, requestId)')
    expect(source).toContain("context.invalidateCatalog('channels')")
    expect(source).toContain('getTeamAuthWithRefresh')
  })
  test('ipc.ts 只保留注册入口，保留共享 getChannelById 依赖', () => {
    expect(source).toContain('export function registerChannelIpc')
    expect(ipc).toContain('registerChannelIpc({')
    expect(ipc).not.toContain('ipcMain.handle(\n    CHANNEL_IPC_CHANNELS.LIST')
    expect(ipc).toContain('getChannelById')
  })
})
