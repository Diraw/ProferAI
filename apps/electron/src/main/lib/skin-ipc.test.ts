import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SKIN_IPC_CHANNELS } from '../../types'

const source = readFileSync(resolve(import.meta.dir, 'skin-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

/**
 * 结构性检查：确认皮肤 IPC 注册完整迁出，且原注册位置仍由宿主调用。
 *
 * 运行时注册依赖 Electron 主进程，行为回归沿用现有 skin-service、skin-manager-service
 * 测试与应用启动验证；这里锁定通道集合、注册入口和 ipc.ts 边界。
 */
describe('皮肤 IPC 注册（结构检查）', () => {
  test('新模块引用全部 11 个皮肤通道', () => {
    for (const key of [
      'GET_SKINS',
      'GET_SKIN_CSS',
      'GET_SKIN_PREVIEW',
      'SELECT_ZIP',
      'SELECT_FOLDER',
      'INSTALL_ZIP',
      'INSTALL_FOLDER',
      'DELETE_USER_SKIN',
      'OPEN_USER_FOLDER',
      'OPEN_TEMPLATE_FOLDER',
      'REFRESH',
    ] as const) {
      expect(source).toContain(`SKIN_IPC_CHANNELS.${key}`)
      expect(SKIN_IPC_CHANNELS[key]).toBeDefined()
    }
    expect(source).toContain('SKIN_IPC_CHANNELS.ON_SKINS_CHANGED')
  })

  test('注册入口为导出函数 registerSkinIpc', () => {
    expect(source).toContain('export function registerSkinIpc(): void')
  })

  test('ipc.ts 在皮肤原位置调用注册函数，且不再保留 handler 定义', () => {
    expect(ipc).toContain('registerSkinIpc()')
    expect(ipc).not.toContain('SKIN_IPC_CHANNELS.GET_SKINS,')
    expect(ipc).not.toContain('const broadcastSkinChanged')
  })
})
