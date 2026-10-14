import { BrowserWindow, ipcMain, Notification } from 'electron'
import { DESKTOP_NOTIFICATION_IPC_CHANNELS } from '../../types'

export function registerDesktopNotificationIpc(): void {
  ipcMain.handle(DESKTOP_NOTIFICATION_IPC_CHANNELS.SHOW, async (event, payload: { title: string; body: string }) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!senderWindow) return
    try {
      const notification = new Notification({
        title: payload.title,
        body: payload.body.slice(0, 200),
        silent: true,
      })
      notification.on('click', () => {
        if (senderWindow.isMinimized()) senderWindow.restore()
        senderWindow.show()
        senderWindow.focus()
        if (!senderWindow.isDestroyed()) {
          senderWindow.webContents.send(DESKTOP_NOTIFICATION_IPC_CHANNELS.CLICKED)
        }
      })
      notification.show()
    } catch (error) {
      console.warn('[桌面通知] 弹出失败:', error)
    }
  })
}
