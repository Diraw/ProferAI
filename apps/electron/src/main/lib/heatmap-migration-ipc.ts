/**
 * 工作区热力图查询与迁移取消清理的 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中搬出两个纯注册。注册顺序与原先一致：
 * 由 registerIpcHandlers 在原位置调用 registerHeatmapMigrationIpc()。
 * 启动时自动清理（runStartupCleanup）是注册期立即执行的副作用，保留在 ipc.ts，不随注册搬迁。
 */
import { ipcMain } from 'electron'
import { realpathSync, existsSync, rmSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENT_IPC_CHANNELS } from '@profer/shared'

export function registerHeatmapMigrationIpc(): void {
  ipcMain.handle(AGENT_IPC_CHANNELS.GET_WORKSPACE_HEATMAP_DAILY, async (_, workspaceId: string) => {
    const { loadWorkspaceHeatmapDaily } = await import('./workspace-heatmap-query')
    return loadWorkspaceHeatmapDaily(workspaceId)
  })

  // 迁移取消时清理临时解压目录
  ipcMain.handle('migration:cancelImport', async (_, tempDir: string) => {
    if (!tempDir || typeof tempDir !== 'string') return
    try {
      // 安全校验：解析真实路径，确保只清理 tmpdir 下的 profer-import-* 目录
      const resolved = realpathSync(resolve(tempDir))
      const tmpRoot = realpathSync(tmpdir())
      if (!resolved.startsWith(tmpRoot + sep)) {
        console.warn('[迁移] 拒绝清理非临时目录:', tempDir)
        return
      }
      const dirName = basename(resolved)
      if (!dirName.startsWith('profer-import-')) {
        console.warn('[迁移] 目录名不匹配，拒绝清理:', dirName)
        return
      }
      if (existsSync(resolved)) {
        rmSync(resolved, { recursive: true, force: true })
        console.log(`[迁移] 已清理临时目录: ${resolved}`)
      }
    } catch {
      // 目录不存在或无法解析，无需清理
    }
  })
}
