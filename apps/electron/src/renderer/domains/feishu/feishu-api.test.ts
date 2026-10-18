import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as feishuApi from './feishu-api'

type Calls = Array<{ name: string; args: unknown[] }>

let calls: Calls
const originalWindow = (globalThis as { window?: unknown }).window

function installHost(tag: string): void {
  const stub = (name: string, result: unknown = `${tag}:${name}`) => (...args: unknown[]) => {
    calls.push({ name, args })
    return result
  }
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      getPlatformInfo: () => ({ platform: 'darwin', arch: 'arm64' }),
      openExternal: stub('openExternal'),
      updateFeishuBinding: stub('updateFeishuBinding'),
      testFeishuConnection: stub('testFeishuConnection'),
      listFeishuBindings: stub('listFeishuBindings'),
      getFeishuMultiStatus: stub('getFeishuMultiStatus'),
    },
  }
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

test('包装函数在调用时读取当前 window.electronAPI，而不是导入时缓存', async () => {
  installHost('first')
  const first = await feishuApi.listFeishuBindings()
  installHost('second')
  const second = await feishuApi.listFeishuBindings()

  expect(first as unknown).toBe('first:listFeishuBindings')
  expect(second as unknown).toBe('second:listFeishuBindings')
})

test('参数原样转发到宿主，返回值不被改写', async () => {
  installHost('h')
  const result = await feishuApi.testFeishuConnection('app-id', 'secret')
  const update = await feishuApi.updateFeishuBinding({ chatId: 'c1', workspaceSlug: 'w' } as never)

  expect(result as unknown).toBe('h:testFeishuConnection')
  expect(update as unknown).toBe('h:updateFeishuBinding')
  expect(calls).toEqual([
    { name: 'testFeishuConnection', args: ['app-id', 'secret'] },
    { name: 'updateFeishuBinding', args: [{ chatId: 'c1', workspaceSlug: 'w' }] },
  ])
})

test('平台信息同步返回，不经过 Promise 包装', () => {
  installHost('h')
  expect(feishuApi.getPlatformInfo().platform).toBe('darwin')
})

test('无参数方法也转发调用，且不丢失宿主的可选参数', async () => {
  installHost('h')
  await feishuApi.getFeishuMultiStatus()
  expect(calls).toEqual([{ name: 'getFeishuMultiStatus', args: [] }])
})
