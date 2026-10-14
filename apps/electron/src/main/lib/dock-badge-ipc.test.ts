import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DOCK_BADGE_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'dock-badge-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('Dock 角标 IPC 注册（结构检查）', () => {
  test('新模块引用 SET_COUNT 通道并转发服务结果', () => {
    expect(source).toContain('DOCK_BADGE_IPC_CHANNELS.SET_COUNT')
    expect(DOCK_BADGE_IPC_CHANNELS.SET_COUNT).toBeDefined()
    expect(source).toContain('return setDockBadgeCount(count)')
  })

  test('注册入口为导出函数 registerDockBadgeIpc', () => {
    expect(source).toContain('export function registerDockBadgeIpc(): void')
  })

  test('ipc.ts 在原位置调用注册函数，且不再保留 handler 定义', () => {
    expect(ipc).toContain('registerDockBadgeIpc()')
    expect(ipc).not.toContain('DOCK_BADGE_IPC_CHANNELS.SET_COUNT,')
  })
})
