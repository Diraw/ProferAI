import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

/**
 * 解除全局预设的工作区生效范围：绑定了该预设的会话必须阻断，且不能留下失效引用。
 * 使用独立配置目录与隔离的模块实例，避免与预设测试互相污染。
 */
let root = ''
let presets: typeof import('./agent-preset-manager')
let sessions: typeof import('./agent-session-manager')

// 测试替身把工作区 id 与 slug 设为同一值，会话的 workspaceId 也必须用它
const WS_SLUG = 'ws-scope-test'

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-preset-scope-test-'))
  process.env.PROFER_CONFIG_DIR = root
  const key = `${Date.now()}-${Math.random()}`
  presets = await import(`./agent-preset-manager?scope-test=${key}`)
  sessions = await import(`./agent-session-manager?scope-test=${key}`)
  presets.__setAgentPresetsBaseDirForTest(root)
  // 阻断判定遍历的是 listManagedWorkspaces；未注入工作区时列表为空，会话不会被检查
  presets.__setAgentPresetMigrationWorkspacesForTest([WS_SLUG])
})

afterEach(() => {
  presets.__resetAgentPresetsBaseDirForTest()
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('解除全局预设的工作区生效范围', () => {
  test('没有任何会话绑定时可以解除，且解除后该预设不再可解析', () => {
    const preset = presets.createGlobalAgentPreset({ name: '无会话绑定', description: '' })
    const reference = { presetId: preset.id, presetScope: 'user-global' as const }
    presets.enableGlobalPresetInWorkspace(WS_SLUG, reference)

    expect(() => presets.disableGlobalPresetInWorkspace(WS_SLUG, reference)).not.toThrow()
    expect(() => presets.resolvePresetReference(reference, WS_SLUG)).toThrow('解除当前工作区生效范围')
  })

  test('仍有会话绑定时必须以 PRESET_DELETE_BLOCKED 拒绝，并且保留生效范围', () => {
    const preset = presets.createGlobalAgentPreset({ name: '被会话引用', description: '' })
    const reference = { presetId: preset.id, presetScope: 'user-global' as const }
    presets.enableGlobalPresetInWorkspace(WS_SLUG, reference)

    // 写入一个绑定该预设的会话索引（与运行时读取的索引文件位置一致）
    writeFileSync(
      join(root, 'agent-sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [{
          id: 'sess-bound',
          title: '绑定会话',
          workspaceId: WS_SLUG,
          createdAt: 1,
          updatedAt: 1,
          presetId: preset.id,
          presetReference: reference,
        }],
      }),
    )
    // 工作区列表由 listManagedWorkspaces 决定；这里只验证阻断判定本身，若无法注册工作区则用例会失败并暴露问题
    expect(sessions.listAgentSessions(true).some((s) => s.id === 'sess-bound')).toBe(true)

    let code: string | undefined
    try {
      presets.disableGlobalPresetInWorkspace(WS_SLUG, reference)
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('PRESET_DELETE_BLOCKED')
    // 被拒绝后生效范围必须保持，否则会留下失效引用
    expect(() => presets.resolvePresetReference(reference, WS_SLUG)).not.toThrow()
  })
})
