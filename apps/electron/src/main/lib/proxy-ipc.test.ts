import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROXY_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'proxy-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('代理配置 IPC 注册（结构检查）', () => {
  test('新模块引用 GET、UPDATE、DETECT 三个通道', () => {
    for (const key of ['GET_SETTINGS', 'UPDATE_SETTINGS', 'DETECT_SYSTEM'] as const) {
      expect(source).toContain(`PROXY_IPC_CHANNELS.${key}`)
      expect(PROXY_IPC_CHANNELS[key]).toBeDefined()
    }
  })

  test('保留代理配置服务和系统代理检测服务转发', () => {
    expect(source).toContain('return getProxySettings()')
    expect(source).toContain('await saveProxySettings(config)')
    expect(source).toContain('return detectSystemProxy()')
  })

  test('注册入口为导出函数 registerProxyIpc', () => {
    expect(source).toContain('export function registerProxyIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留 handler 定义', () => {
    expect(ipc).toContain('registerProxyIpc()')
    expect(ipc).not.toContain('PROXY_IPC_CHANNELS.GET_SETTINGS,')
    expect(ipc).not.toContain('PROXY_IPC_CHANNELS.DETECT_SYSTEM,')
  })
})
