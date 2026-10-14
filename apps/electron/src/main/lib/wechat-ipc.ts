import { ipcMain } from 'electron'
import { WECHAT_IPC_CHANNELS, type WeChatBridgeState, type WeChatConfig } from '@profer/shared'
import { getWeChatConfig } from './wechat-config'
import { wechatBridge } from './wechat-bridge'

export function registerWeChatIpc(): void {
  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_CONFIG,
    async (): Promise<WeChatConfig> => getWeChatConfig(),
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_LOGIN,
    async (): Promise<void> => {
      await wechatBridge.startLogin()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.LOGOUT,
    async (): Promise<void> => {
      wechatBridge.logout()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.START_BRIDGE,
    async (): Promise<void> => {
      await wechatBridge.start()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.STOP_BRIDGE,
    async (): Promise<void> => {
      wechatBridge.stop()
    },
  )

  ipcMain.handle(
    WECHAT_IPC_CHANNELS.GET_STATUS,
    async (): Promise<WeChatBridgeState> => wechatBridge.getStatus(),
  )
}
