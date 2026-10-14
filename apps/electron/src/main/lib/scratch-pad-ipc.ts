/**
 * Scratch Pad 持久化与导出 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致：
 * 由 registerIpcHandlers 在 Scratch Pad 段原位置调用 registerScratchPadIpc()。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { SCRATCH_PAD_IPC_CHANNELS } from '../../types'
import { getScratchPadPath } from './config-paths'

export function registerScratchPadIpc(): void {
  // 从磁盘加载 scratch-pad.md
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.LOAD,
    async (): Promise<string> => {
      const path = getScratchPadPath()
      try {
        if (!existsSync(path)) return ''
        return readFileSync(path, 'utf-8')
      } catch (err) {
        console.error('[ScratchPad] 加载失败:', err)
        return ''
      }
    }
  )

  // 异步保存 scratch-pad.md
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.SAVE,
    async (_, content: string): Promise<boolean> => {
      const path = getScratchPadPath()
      try {
        await writeFile(path, content, 'utf-8')
        return true
      } catch (err) {
        console.error('[ScratchPad] 保存失败:', err)
        return false
      }
    }
  )

  // 同步保存 scratch-pad.md（beforeunload 场景）
  ipcMain.on(
    SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC,
    (event, content: string) => {
      try {
        writeFileSync(getScratchPadPath(), content, 'utf-8')
        event.returnValue = true
      } catch (err) {
        console.error('[ScratchPad] 同步保存失败:', err)
        event.returnValue = false
      }
    }
  )

  // 导出为 Markdown 到指定目录
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.EXPORT,
    async (_, markdown: string, dirPath: string, filename: string): Promise<string> => {
      let filePath: string
      if (!filename) {
        // 完整文件路径模式（来自保存对话框）
        filePath = dirPath
        const dir = dirname(filePath)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
      } else {
        if (!existsSync(dirPath)) {
          mkdirSync(dirPath, { recursive: true })
        }
        filePath = join(dirPath, filename)
      }
      writeFileSync(filePath, markdown, 'utf-8')
      console.log('[ScratchPad] 已导出:', filePath)
      return filePath
    }
  )

  // 打开保存对话框，返回用户选择的路径
  ipcMain.handle(
    SCRATCH_PAD_IPC_CHANNELS.CHOOSE_EXPORT_PATH,
    async (_, defaultName: string): Promise<string | null> => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return null
      const result = await dialog.showSaveDialog(win, {
        title: '导出 Scratch Pad 为 Markdown',
        defaultPath: defaultName,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      return result.canceled ? null : result.filePath
    }
  )
}
