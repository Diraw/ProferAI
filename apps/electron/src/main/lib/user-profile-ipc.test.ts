import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { USER_PROFILE_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'user-profile-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('用户档案 IPC 注册（结构检查）', () => {
  test('新模块引用 GET 与 UPDATE 通道', () => {
    for (const key of ['GET', 'UPDATE'] as const) {
      expect(source).toContain(`USER_PROFILE_IPC_CHANNELS.${key}`)
      expect(USER_PROFILE_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('注册入口为导出函数 registerUserProfileIpc', () => {
    expect(source).toContain('export function registerUserProfileIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留 handler 定义', () => {
    expect(ipc).toContain('registerUserProfileIpc()')
    expect(ipc).not.toContain('USER_PROFILE_IPC_CHANNELS.GET,')
    expect(ipc).not.toContain('USER_PROFILE_IPC_CHANNELS.UPDATE,')
  })
})
