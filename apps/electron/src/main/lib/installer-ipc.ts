import { BrowserWindow, ipcMain } from 'electron'
import { INSTALLER_IPC_CHANNELS } from '@profer/shared'
import type { InstallerDownloadRequest, InstallerDownloadResult, InstallerManifest, InstallerSource } from '@profer/shared'
import { fetchInstallerManifest, findInstallerSource } from './installer-manifest'
import { cancelInstallerDownload, downloadInstaller, launchInstaller } from './installer-downloader'

export function registerInstallerIpc(): void {
  ipcMain.handle(INSTALLER_IPC_CHANNELS.MANIFEST, async (): Promise<InstallerManifest> => fetchInstallerManifest())
  ipcMain.handle(INSTALLER_IPC_CHANNELS.DOWNLOAD, async (event, req: InstallerDownloadRequest): Promise<InstallerDownloadResult> => {
    const manifest = await fetchInstallerManifest()
    const source = findInstallerSource(manifest, req.id, req.arch, req.platform ?? (process.platform as InstallerSource['platform']))
    if (!source) throw new Error(`未找到安装包：id=${req.id}, arch=${req.arch}`)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error('发起下载的窗口已关闭')
    return downloadInstaller(source, `${req.id}:${req.arch}`, window)
  })
  ipcMain.handle(INSTALLER_IPC_CHANNELS.CANCEL, async (_event, key: string): Promise<boolean> => cancelInstallerDownload(key))
  ipcMain.handle(INSTALLER_IPC_CHANNELS.LAUNCH, async (_event, filePath: string): Promise<void> => launchInstaller(filePath))
}
