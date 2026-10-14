import { dialog, ipcMain } from 'electron'

export function registerMigrationIpc(): void {
  ipcMain.handle('migration:getExportPreview', async (_, workspaceId: string) => {
    const { getExportPreview } = await import('./migration-service')
    return getExportPreview(workspaceId)
  })
  ipcMain.handle('migration:getShareExportPreview', async () => {
    const { getShareExportPreview } = await import('./migration-service')
    return getShareExportPreview()
  })
  ipcMain.handle('migration:export', async (_, options) => {
    const { exportData } = await import('./migration-service')
    return exportData(options)
  })
  ipcMain.handle('migration:exportV2', async (_, options) => {
    const { exportDataV2 } = await import('./migration-service')
    return exportDataV2(options)
  })
  ipcMain.handle('migration:parseImportFile', async (_, filePath: string) => {
    const { parseImportFile } = await import('./migration-service')
    return parseImportFile(filePath)
  })
  ipcMain.handle('migration:confirmImport', async (_, options) => {
    const { confirmImport } = await import('./migration-service')
    return confirmImport(options)
  })
  ipcMain.handle('migration:openFileDialog', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择迁移文件',
      filters: [
        { name: 'Profer 迁移文件', extensions: ['profer-backup', 'profer-share'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('migration:saveFileDialog', async (_, mode: string) => {
    const ext = mode === 'personal' ? 'profer-backup' : 'profer-share'
    const defaultName = `profer-migration-${new Date().toISOString().slice(0, 10)}.${ext}`
    const result = await dialog.showSaveDialog({
      title: '保存迁移文件',
      defaultPath: defaultName,
      filters: [{ name: mode === 'personal' ? 'Profer 个人备份' : 'Profer 分享包', extensions: [ext] }],
    })
    return result.canceled ? null : result.filePath
  })
}
