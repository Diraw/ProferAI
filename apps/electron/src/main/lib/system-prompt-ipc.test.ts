import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SYSTEM_PROMPT_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'system-prompt-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('系统提示词 IPC 注册（结构检查）', () => {
  test('新模块覆盖全部六个通道', () => {
    for (const key of ['GET_CONFIG', 'CREATE', 'UPDATE', 'DELETE', 'UPDATE_APPEND_SETTING', 'SET_DEFAULT'] as const) {
      expect(source).toContain(`SYSTEM_PROMPT_IPC_CHANNELS.${key}`)
      expect(SYSTEM_PROMPT_IPC_CHANNELS[key]).toBeDefined()
    }
  })
  test('注册入口与 ipc.ts 边界存在', () => {
    expect(source).toContain('export function registerSystemPromptIpc(): void')
    expect(ipc).toContain('registerSystemPromptIpc()')
    expect(ipc).not.toContain('SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG,')
  })
})
