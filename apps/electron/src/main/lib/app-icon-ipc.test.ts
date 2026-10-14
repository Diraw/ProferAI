import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APP_ICON_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'app-icon-ipc.ts'), 'utf8')
const service = readFileSync(resolve(import.meta.dir, 'app-icon-service.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('应用图标 IPC 注册（结构检查）', () => {
  test('新模块引用 SET 通道并保留图标切换副作用', () => {
    expect(source).toContain('APP_ICON_IPC_CHANNELS.SET')
    expect(APP_ICON_IPC_CHANNELS.SET).toBeDefined()
    expect(source).toContain('app.dock.setIcon(iconPath)')
    expect(source).toContain('updateSettings({ appIconVariant: variantId })')
  })

  test('图标路径解析独立于 IPC 且保留默认与变体路径', () => {
    expect(service).toContain('export function resolveAppIconPath')
    expect(service).toContain("join(resourcesDir, 'icon.png')")
    expect(service).toContain("join(resourcesDir, 'profer-logos', `profer-${variantId}.png`)")
  })

  test('注册入口为导出函数 registerAppIconIpc', () => {
    expect(source).toContain('export function registerAppIconIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数并保留兼容 re-export', () => {
    expect(ipc).toContain('registerAppIconIpc()')
    expect(ipc).toContain("export { resolveAppIconPath } from './lib/app-icon-service'")
    expect(ipc).not.toContain('APP_ICON_IPC_CHANNELS.SET,')
  })
})
