/**
 * 皮肤管理 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致：
 * 由 registerIpcHandlers 在皮肤段原位置调用 registerSkinIpc()。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { SKIN_IPC_CHANNELS } from '../../types'
import { scanSkins, getSkinCss, getSkinPreview, invalidateSkinCache } from './skin-service'
import { deleteUserSkin, installSkinFromFolder, installSkinFromZip, openSkinTemplateFolder, openUserSkinsFolder, selectSkinFolder, selectSkinZip } from './skin-manager-service'

/** 皮肤注册表/CSS 变化后广播给所有窗口（排除发起者，发起者自己刷新）。 */
function broadcastSkinChanged(senderId: number, deletedId?: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win.webContents.id === senderId) return
    win.webContents.send(SKIN_IPC_CHANNELS.ON_SKINS_CHANGED, { deletedId: deletedId ?? null })
  })
}

export function registerSkinIpc(): void {
  ipcMain.handle(SKIN_IPC_CHANNELS.GET_SKINS, async () => scanSkins())
  ipcMain.handle(SKIN_IPC_CHANNELS.GET_SKIN_CSS, async (_event, id: unknown) => typeof id === 'string' ? getSkinCss(id) : null)
  ipcMain.handle(SKIN_IPC_CHANNELS.GET_SKIN_PREVIEW, async (_event, id: unknown) => typeof id === 'string' ? getSkinPreview(id) : null)
  ipcMain.handle(SKIN_IPC_CHANNELS.SELECT_ZIP, async () => selectSkinZip())
  ipcMain.handle(SKIN_IPC_CHANNELS.SELECT_FOLDER, async () => selectSkinFolder())
  ipcMain.handle(SKIN_IPC_CHANNELS.INSTALL_ZIP, async (event, path: unknown, replace: unknown) => {
    const result = typeof path === 'string' ? installSkinFromZip(path, replace === true) : { ok: false, status: 'error', message: '无效 ZIP 路径' }
    if (result.ok) broadcastSkinChanged(event.sender.id)
    return result
  })
  ipcMain.handle(SKIN_IPC_CHANNELS.INSTALL_FOLDER, async (event, path: unknown, replace: unknown) => {
    const result = typeof path === 'string' ? installSkinFromFolder(path, replace === true) : { ok: false, status: 'error', message: '无效文件夹路径' }
    if (result.ok) broadcastSkinChanged(event.sender.id)
    return result
  })
  ipcMain.handle(SKIN_IPC_CHANNELS.DELETE_USER_SKIN, async (event, id: unknown) => {
    const result = typeof id === 'string' ? deleteUserSkin(id) : { ok: false, status: 'error', message: '无效皮肤 id' }
    if (result.ok) broadcastSkinChanged(event.sender.id, typeof id === 'string' ? id : undefined)
    return result
  })
  ipcMain.handle(SKIN_IPC_CHANNELS.OPEN_USER_FOLDER, async () => openUserSkinsFolder())
  ipcMain.handle(SKIN_IPC_CHANNELS.OPEN_TEMPLATE_FOLDER, async () => openSkinTemplateFolder())
  ipcMain.handle(SKIN_IPC_CHANNELS.REFRESH, async (event) => {
    invalidateSkinCache()
    const skins = scanSkins()
    broadcastSkinChanged(event.sender.id)
    return skins
  })
}
