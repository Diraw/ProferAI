import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { VOICE_DICTATION_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'voice-dictation-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('语音输入 IPC 注册（结构检查）', () => {
  test('覆盖设置、ASR、窗口和权限通道', () => {
    for (const key of ['GET_SETTINGS', 'UPDATE_SETTINGS', 'TEST_CONNECTION', 'TOGGLE', 'START', 'SEND_AUDIO', 'STOP', 'CANCEL', 'COMMIT', 'HIDE', 'RESIZE', 'CHECK_MIC_PERMISSION', 'REQUEST_MIC_PERMISSION'] as const) expect(source).toContain(`VOICE_DICTATION_IPC_CHANNELS.${key}`)
    expect(source).toContain('BrowserWindow.fromWebContents(event.sender)')
  })
  test('ipc.ts 只保留注册入口', () => {
    expect(ipc).toContain('registerVoiceDictationIpc()')
    expect(ipc).not.toContain('ipcMain.handle(VOICE_DICTATION_IPC_CHANNELS.GET_SETTINGS')
  })
})
