import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SCRATCH_PAD_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'scratch-pad-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Scratch Pad IPC 注册（结构检查）', () => {
  test('新模块引用全部 5 个 Scratch Pad 通道', () => {
    for (const key of ['LOAD', 'SAVE', 'SAVE_SYNC', 'EXPORT', 'CHOOSE_EXPORT_PATH'] as const) {
      expect(source).toContain(`SCRATCH_PAD_IPC_CHANNELS.${key}`)
      expect(SCRATCH_PAD_IPC_CHANNELS[key]).toBeDefined()
    }
    expect(source).toContain('ipcMain.on(')
    expect(source).toContain('event.returnValue')
  })

  test('保留导出对话框与 Scratch Pad 文件路径依赖', () => {
    expect(source).toContain('dialog.showSaveDialog')
    expect(source).toContain('getScratchPadPath()')
    expect(source).toContain("'[ScratchPad] 已导出:'")
  })

  test('注册入口为导出函数 registerScratchPadIpc', () => {
    expect(source).toContain('export function registerScratchPadIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留 Scratch Pad handler 定义', () => {
    expect(ipc).toContain('registerScratchPadIpc()')
    expect(ipc).not.toContain('SCRATCH_PAD_IPC_CHANNELS.LOAD,')
    expect(ipc).not.toContain('SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC,')
    expect(ipc).not.toContain("'[ScratchPad] 已导出:'")
  })
})
