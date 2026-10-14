import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@profer/shared'

export function registerWindowIpc(): void {
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.minimize()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (process.platform === 'darwin') {
      win.setFullScreen(!win.isFullScreen())
      return
    }
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.close()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win.isMaximized() : false
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_FULL_SCREEN, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win.isFullScreen() : false
  })
}
