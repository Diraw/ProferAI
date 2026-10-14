import { ipcMain, shell } from 'electron'
import { KNOWLEDGE_IPC_CHANNELS } from '@profer/shared'

export function registerKnowledgeIpc(): void {
  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.IMPORT_ITEMS, async (_, filePaths: string[]) => {
    if (!Array.isArray(filePaths) || filePaths.length < 1 || filePaths.length > 10 || filePaths.some((path) => typeof path !== 'string' || !path.trim() || path.length > 4096)) {
      throw new Error('资料导入数量或路径无效')
    }
    const { importKnowledgeItems } = require('./knowledge-item-service')
    return importKnowledgeItems(filePaths)
  })
  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.LIST_ITEMS, async () => {
    const { listKnowledgeItems } = require('./knowledge-item-service')
    return listKnowledgeItems()
  })
  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.GET_LIBRARY_SNAPSHOT, async () => {
    const { getKnowledgeLibrarySnapshot } = require('./knowledge-item-service')
    return getKnowledgeLibrarySnapshot()
  })
  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.GET_ITEM, async (_, itemId: string) => {
    if (typeof itemId !== 'string' || itemId.length > 160) throw new Error('资料标识无效')
    const { getKnowledgeItem } = require('./knowledge-item-service')
    return getKnowledgeItem(itemId)
  })
  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.DELETE_ITEM, async (_, itemId: string) => {
    if (typeof itemId !== 'string' || itemId.length > 160) throw new Error('资料标识无效')
    const { deleteKnowledgeItem } = require('./knowledge-item-service')
    return deleteKnowledgeItem(itemId)
  })
  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.SEARCH_ITEMS, async (_, query: string, itemIds?: string[], topK?: number) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('搜索关键词无效')
    if (itemIds !== undefined && (!Array.isArray(itemIds) || itemIds.length > 10 || itemIds.some((id) => typeof id !== 'string' || id.length > 160))) throw new Error('资料范围无效')
    if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > 20)) throw new Error('搜索数量无效')
    const { searchKnowledgeItems } = require('./knowledge-item-service')
    return searchKnowledgeItems(query, itemIds, topK)
  })
  ipcMain.handle(KNOWLEDGE_IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, async (_, itemId: string): Promise<void> => {
    if (typeof itemId !== 'string' || itemId.length > 160) throw new Error('资料标识无效')
    const { getKnowledgeItemStoredFilePath } = require('./knowledge-item-service')
    const storedPath = getKnowledgeItemStoredFilePath(itemId)
    if (!storedPath) throw new Error('该资料没有可显示的本地文件副本')
    shell.showItemInFolder(storedPath)
  })
}
