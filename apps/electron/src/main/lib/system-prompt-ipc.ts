/** 系统提示词 IPC 注册。 */
import { ipcMain } from 'electron'
import { SYSTEM_PROMPT_IPC_CHANNELS } from '@profer/shared'
import type { SystemPrompt, SystemPromptConfig, SystemPromptCreateInput, SystemPromptUpdateInput } from '@profer/shared'
import {
  getSystemPromptConfig,
  createSystemPrompt,
  updateSystemPrompt,
  deleteSystemPrompt,
  updateAppendSetting,
  setDefaultPrompt,
} from './system-prompt-manager'

export function registerSystemPromptIpc(): void {
  ipcMain.handle(SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG, async (): Promise<SystemPromptConfig> => getSystemPromptConfig())
  ipcMain.handle(SYSTEM_PROMPT_IPC_CHANNELS.CREATE, async (_, input: SystemPromptCreateInput): Promise<SystemPrompt> => createSystemPrompt(input))
  ipcMain.handle(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE, async (_, id: string, input: SystemPromptUpdateInput): Promise<SystemPrompt> => updateSystemPrompt(id, input))
  ipcMain.handle(SYSTEM_PROMPT_IPC_CHANNELS.DELETE, async (_, id: string): Promise<void> => deleteSystemPrompt(id))
  ipcMain.handle(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING, async (_, enabled: boolean): Promise<void> => updateAppendSetting(enabled))
  ipcMain.handle(SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT, async (_, id: string | null): Promise<void> => setDefaultPrompt(id))
}
