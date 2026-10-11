import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ENVIRONMENT_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'environment-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('环境检测 IPC 注册（结构检查）', () => {
  test('新模块引用 CHECK 通道和环境检测服务', () => {
    expect(source).toContain('ENVIRONMENT_IPC_CHANNELS.CHECK')
    expect(ENVIRONMENT_IPC_CHANNELS.CHECK).toBeDefined()
    expect(source).toContain('const result = await checkEnvironment()')
  })

  test('保留检测结果写回设置且返回同一结果', () => {
    expect(source).toContain('lastEnvironmentCheck: result')
    expect(source).toContain('return result')
  })

  test('注册入口为导出函数 registerEnvironmentIpc', () => {
    expect(source).toContain('export function registerEnvironmentIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留 handler 定义', () => {
    expect(ipc).toContain('registerEnvironmentIpc()')
    expect(ipc).not.toContain('ENVIRONMENT_IPC_CHANNELS.CHECK,')
  })
})
