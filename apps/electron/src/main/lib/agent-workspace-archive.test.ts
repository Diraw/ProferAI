/**
 * 工作区收纳（归档）行为测试
 *
 * 覆盖 updateAgentWorkspace 的 archived 分支，以及"收纳不改动底层列表"这一
 * 关键约束 —— 桥接/飞书入口读的是全量列表，工作区被收纳不能让它消失。
 *
 * 环境隔离方式与 migration-service.test.ts 一致：mock electron + 临时配置根。
 */
import { afterAll, describe, expect, test, mock } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

const configRoot = join(tmpdir(), `profer-workspace-archive-${Date.now()}`)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  createAgentWorkspace,
  updateAgentWorkspace,
  listAgentWorkspaces,
  getAgentWorkspace,
  ensureDefaultWorkspace,
} = await import('./agent-workspace-manager')
const { getAgentWorkspacesIndexPath } = await import('./config-paths')

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

describe('工作区收纳', () => {
  test('收纳写入 archived/archivedAt，取出后字段被清理', () => {
    const ws = createAgentWorkspace('收纳往返')

    const archived = updateAgentWorkspace(ws.id, { archived: true })
    expect(archived.archived).toBe(true)
    expect(typeof archived.archivedAt).toBe('number')
    expect(getAgentWorkspace(ws.id)?.archived).toBe(true)

    const restored = updateAgentWorkspace(ws.id, { archived: false })
    expect(restored.archived).toBeUndefined()
    expect(restored.archivedAt).toBeUndefined()
    expect(getAgentWorkspace(ws.id)?.archived).toBeUndefined()
  })

  test('重复收纳保持首次 archivedAt，不刷新时间戳', () => {
    const ws = createAgentWorkspace('重复收纳')
    const first = updateAgentWorkspace(ws.id, { archived: true })
    const second = updateAgentWorkspace(ws.id, { archived: true })
    expect(second.archivedAt).toBe(first.archivedAt!)
    expect(second.archived).toBe(true)
  })

  test('收纳不改动名称与 slug，且落盘仍保留 name 键', () => {
    const ws = createAgentWorkspace('名称保持不变')
    const archived = updateAgentWorkspace(ws.id, { archived: true })
    expect(archived.name).toBe('名称保持不变')
    expect(archived.slug).toBe(ws.slug)

    // 读-改-写循环不能把未提供的字段写成 undefined：
    // 一旦 name 在落盘时被抹掉，重启后项目名就会变空白（真实发生过的缺陷）。
    const raw = readFileSync(getAgentWorkspacesIndexPath(), 'utf-8')
    expect(raw).toContain('名称保持不变')
  })

  test('只传 archived 时跳过重名校验，不被同名逻辑误伤', () => {
    createAgentWorkspace('重名干扰项')
    const other = createAgentWorkspace('待收纳项目')
    expect(() => updateAgentWorkspace(other.id, { archived: true })).not.toThrow()
  })

  test('改名时仍执行重名校验', () => {
    const a = createAgentWorkspace('重名校验甲')
    createAgentWorkspace('重名校验乙')
    expect(() => updateAgentWorkspace(a.id, { name: '重名校验乙' })).toThrow('已存在')
  })

  test('默认工作区不可收纳', () => {
    const def = ensureDefaultWorkspace()
    expect(() => updateAgentWorkspace(def.id, { archived: true })).toThrow('默认工作区不能收纳')
    expect(getAgentWorkspace(def.id)?.archived).toBeUndefined()
  })

  test('收纳的工作区仍留在底层列表，只由可见性开关过滤', () => {
    const before = listAgentWorkspaces().length
    const ws = createAgentWorkspace('仍在底层列表')
    updateAgentWorkspace(ws.id, { archived: true })

    const all = listAgentWorkspaces()
    expect(all.length).toBe(before + 1)
    expect(all.some((item) => item.id === ws.id && item.archived === true)).toBe(true)
  })

  test('收纳状态跨读取持久化', () => {
    const ws = createAgentWorkspace('持久化检查')
    updateAgentWorkspace(ws.id, { archived: true })

    // getAgentWorkspace 重新读索引文件，模拟下次启动
    const reloaded = getAgentWorkspace(ws.id)
    expect(reloaded?.archived).toBe(true)
    expect(typeof reloaded?.archivedAt).toBe('number')
  })

  test('未知工作区 id 抛错', () => {
    expect(() => updateAgentWorkspace('not-a-real-id', { archived: true })).toThrow('不存在')
  })
})
