import { ipcMain } from 'electron'
import { QUICK_TASK_IPC_CHANNELS } from '../../types'
import type { QuickTaskSubmitInput } from '../../types'

export function registerQuickTaskIpc(): void {
  ipcMain.handle(QUICK_TASK_IPC_CHANNELS.SUBMIT, async (_, input: QuickTaskSubmitInput): Promise<void> => {
    const { hideQuickTaskWindow } = await import('./quick-task-window')
    const { getMainWindow } = await import('../index')
    hideQuickTaskWindow()

    const mainWin = getMainWindow()
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('quick-task:open-session', {
        mode: input.mode,
        text: input.text,
        files: input.files,
      })
      mainWin.show()
      mainWin.focus()
    }
  })

  ipcMain.handle(QUICK_TASK_IPC_CHANNELS.HIDE, async (): Promise<void> => {
    const { hideQuickTaskWindow } = await import('./quick-task-window')
    hideQuickTaskWindow()
  })

  ipcMain.handle(QUICK_TASK_IPC_CHANNELS.REREGISTER_GLOBAL_SHORTCUTS, async (): Promise<Record<string, boolean>> => {
    const { reregisterAllGlobalShortcuts } = await import('./global-shortcut-service')
    return reregisterAllGlobalShortcuts()
  })
}
