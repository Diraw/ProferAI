import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INSTALLER_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'installer-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('安装器 IPC 注册（结构检查）', () => {
  test('覆盖 manifest、下载、取消和启动，并保留窗口下载语义', () => {
    for (const key of ['MANIFEST', 'DOWNLOAD', 'CANCEL', 'LAUNCH'] as const) {
      expect(source).toContain(`INSTALLER_IPC_CHANNELS.${key}`)
      expect(INSTALLER_IPC_CHANNELS[key]).toBeDefined()
    }
    expect(source).toContain('BrowserWindow.fromWebContents(event.sender)')
    expect(source).toContain('`${req.id}:${req.arch}`')
    expect(source).toContain('cancelInstallerDownload')
    expect(source).toContain('launchInstaller')
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(source).toContain('export function registerInstallerIpc(): void')
    expect(ipc).toContain('registerInstallerIpc()')
    expect(ipc).not.toContain('ipcMain.handle(\n    INSTALLER_IPC_CHANNELS.MANIFEST')
  })
})
