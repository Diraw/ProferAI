import { BrowserWindow, ipcMain } from 'electron'
import { LARK_IPC_CHANNELS, type LarkMcpCredentialsInput } from '@profer/shared'
import {
  cancelLarkLogin,
  detectLarkCli,
  installLarkCli,
  startLarkLogin,
  __setLarkLoginEventHandler,
} from './lark-cli-service'
import {
  cancelLarkMcpLogin,
  disableLarkMcpForWorkspace,
  enableLarkMcpForWorkspace,
  getLarkMcpStatus,
  saveLarkMcpCredentials,
  startLarkMcpLogin,
  testLarkMcpConnection,
  __setLarkMcpLoginEventHandler,
} from './lark-mcp-service'

export interface LarkIpcContext {
  getAllWindows?: () => BrowserWindow[]
}

function broadcast(getAllWindows: () => BrowserWindow[], channel: string, payload: unknown): void {
  for (const window of getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

export function registerLarkIpc(context: LarkIpcContext = {}): void {
  const getAllWindows = context.getAllWindows ?? (() => BrowserWindow.getAllWindows())

  __setLarkLoginEventHandler((payload) => {
    broadcast(getAllWindows, LARK_IPC_CHANNELS.LOGIN_EVENT, payload)
  })
  __setLarkMcpLoginEventHandler((payload) => {
    broadcast(getAllWindows, LARK_IPC_CHANNELS.MCP_LOGIN_EVENT, payload)
  })

  ipcMain.handle(LARK_IPC_CHANNELS.GET_STATUS, async () => detectLarkCli())
  ipcMain.handle(LARK_IPC_CHANNELS.REFRESH_STATUS, async () => detectLarkCli())
  ipcMain.handle(LARK_IPC_CHANNELS.GET_MCP_STATUS, async () => getLarkMcpStatus())
  ipcMain.handle(LARK_IPC_CHANNELS.SAVE_MCP_CREDENTIALS, async (_, input: LarkMcpCredentialsInput) => saveLarkMcpCredentials(input))
  ipcMain.handle(LARK_IPC_CHANNELS.ENABLE_MCP_FOR_WORKSPACE, async (_, workspaceSlug: string) => enableLarkMcpForWorkspace(workspaceSlug))
  ipcMain.handle(LARK_IPC_CHANNELS.DISABLE_MCP_FOR_WORKSPACE, async (_, workspaceSlug: string) => disableLarkMcpForWorkspace(workspaceSlug))
  ipcMain.handle(LARK_IPC_CHANNELS.START_MCP_LOGIN, async () => startLarkMcpLogin())
  ipcMain.handle(LARK_IPC_CHANNELS.CANCEL_MCP_LOGIN, async () => { cancelLarkMcpLogin() })
  ipcMain.handle(LARK_IPC_CHANNELS.TEST_MCP_CONNECTION, async () => testLarkMcpConnection())
  ipcMain.handle(LARK_IPC_CHANNELS.INSTALL_CLI, async () => installLarkCli())
  ipcMain.handle(LARK_IPC_CHANNELS.START_LOGIN, async () => startLarkLogin())
  ipcMain.handle(LARK_IPC_CHANNELS.CANCEL_LOGIN, async () => { cancelLarkLogin() })
}
