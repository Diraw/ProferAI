import { ipcMain } from 'electron'
import { TEAM_FILE_IPC_CHANNELS, TEAM_MEMORY_IPC_CHANNELS } from '@profer/shared'
import {
  createRemoteDirectory,
  deleteRemoteFile,
  downloadFile,
  fetchFileManifest,
  getFileActivities,
  getFileMetadata,
  getFileStatuses,
  getFileTags,
  listTrashEntries,
  moveRemoteFile,
  patchFileMetadata,
  purgeTrashEntry,
  renameRemoteFile,
  restoreTrashEntry,
  searchFiles,
  setFilePreference,
  uploadFile,
} from './team-file-service'
import {
  archiveTeamMemory,
  createTeamMemory,
  listTeamMemories,
  listTeamMemoryRevisions,
  readTeamMemory,
  updateTeamMemory,
} from './team-memory-service'

export interface TeamContentIpcContext {
  assertSensitiveAgentIpcSender: (event: { sender: { isDestroyed(): boolean } }) => void
}

export function registerTeamContentIpc(context: TeamContentIpcContext): void {
  const { assertSensitiveAgentIpcSender } = context

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.CREATE_DIRECTORY,
    async (_, input: { workspaceId: string; dirPath: string }) =>
      createRemoteDirectory(input.workspaceId, input.dirPath),
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.UPLOAD,
    async (_, input: { workspaceId: string; workspaceSlug: string; fileName: string; fileData: Uint8Array; sourcePath?: string }) => {
      const buffer = Buffer.from(input.fileData)
      return uploadFile(input.workspaceId, input.workspaceSlug, input.fileName, buffer, input.sourcePath)
    },
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.DOWNLOAD,
    async (_, input: { workspaceId: string; workspaceSlug: string; filePath: string; uploadedBy?: string; sha256?: string }) =>
      downloadFile(input.workspaceId, input.workspaceSlug, input.filePath, input.uploadedBy, input.sha256),
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.DELETE,
    async (_, input: { workspaceId: string; workspaceSlug: string; filePath: string }) =>
      deleteRemoteFile(input.workspaceId, input.workspaceSlug, input.filePath),
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.GET_MANIFEST,
    async (_, workspaceId: string, workspaceSlug?: string) => fetchFileManifest(workspaceId, workspaceSlug),
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.MOVE,
    async (_, input: { workspaceId: string; workspaceSlug: string; fromPath: string; toDir: string }) =>
      moveRemoteFile(input.workspaceId, input.workspaceSlug, input.fromPath, input.toDir),
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.RENAME,
    async (_, input: { workspaceId: string; workspaceSlug: string; path: string; newName: string }) =>
      renameRemoteFile(input.workspaceId, input.workspaceSlug, input.path, input.newName),
  )

  ipcMain.handle(
    TEAM_FILE_IPC_CHANNELS.SEARCH,
    async (_, workspaceId: string, options: { q: string; page?: number; limit?: number }) =>
      searchFiles(workspaceId, options),
  )
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_METADATA, async (_, workspaceId: string, fileId: string) => getFileMetadata(workspaceId, fileId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.PATCH_METADATA, async (_, workspaceId: string, fileId: string, body: Record<string, unknown>) => patchFileMetadata(workspaceId, fileId, body))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_TAGS, async (_, workspaceId: string) => getFileTags(workspaceId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_STATUSES, async (_, workspaceId: string) => getFileStatuses(workspaceId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.SET_PREFERENCE, async (_, workspaceId: string, fileId: string, body: Record<string, unknown>) => setFilePreference(workspaceId, fileId, body))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.GET_ACTIVITIES, async (_, workspaceId: string, fileId: string, cursor?: string) => getFileActivities(workspaceId, fileId, cursor))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.LIST_TRASH, async (_, workspaceId: string) => listTrashEntries(workspaceId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.RESTORE_TRASH, async (_, workspaceId: string, entryId: string) => restoreTrashEntry(workspaceId, entryId))
  ipcMain.handle(TEAM_FILE_IPC_CHANNELS.PURGE_TRASH, async (_, workspaceId: string, entryId: string) => purgeTrashEntry(workspaceId, entryId))

  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.LIST, async (_, workspaceId: string, includeArchived?: boolean) => listTeamMemories(workspaceId, includeArchived))
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.READ, async (_, workspaceId: string, memoryId: string) => readTeamMemory(workspaceId, memoryId))
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.CREATE, async (event, workspaceId: string, input) => {
    assertSensitiveAgentIpcSender(event)
    return createTeamMemory(workspaceId, input)
  })
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.UPDATE, async (event, workspaceId: string, memoryId: string, input) => {
    assertSensitiveAgentIpcSender(event)
    return updateTeamMemory(workspaceId, memoryId, input)
  })
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.LIST_REVISIONS, async (_, workspaceId: string, memoryId: string) => listTeamMemoryRevisions(workspaceId, memoryId))
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.ARCHIVE, async (event, workspaceId: string, memoryId: string) => {
    assertSensitiveAgentIpcSender(event)
    return archiveTeamMemory(workspaceId, memoryId, true)
  })
  ipcMain.handle(TEAM_MEMORY_IPC_CHANNELS.UNARCHIVE, async (event, workspaceId: string, memoryId: string) => {
    assertSensitiveAgentIpcSender(event)
    return archiveTeamMemory(workspaceId, memoryId, false)
  })
}
