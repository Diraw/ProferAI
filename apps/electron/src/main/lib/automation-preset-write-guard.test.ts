import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateAutomationInput } from '@profer/shared'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  protocol: {},
  safeStorage: {},
  screen: {},
  session: {},
  shell: {},
  systemPreferences: {},
  net: {},
  View: class {},
  WebContentsView: class {},
}))

/**
 * 自动任务写入路径必须拒绝停用的预设。界面层过滤不能替代主进程校验：
 * 任何绕过界面直接调用接口的入口，都不能把停用预设写进自动任务。
 */
let root = ''
let presets: typeof import('./agent-preset-manager')
let automations: typeof import('./automation-manager')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-automation-preset-guard-'))
  process.env.PROFER_CONFIG_DIR = root
  const key = `${Date.now()}-${Math.random()}`
  presets = await import(`./agent-preset-manager?automation-guard=${key}`)
  automations = await import(`./automation-manager?automation-guard=${key}`)
  presets.__setAgentPresetsBaseDirForTest(root)
  presets.__setAgentPresetMigrationWorkspacesForTest(['ws-guard'])
  // 真实的工作区索引：自动任务通过 workspaceId 解析为 slug，需要有对应记录
  writeFileSync(join(root, 'agent-workspaces.json'), JSON.stringify({
    version: 3,
    workspaces: [{ id: WS_ID, slug: WS_SLUG, name: WS_SLUG, createdAt: 1, updatedAt: 1 }],
  }))
})

afterEach(() => {
  presets.__resetAgentPresetsBaseDirForTest()
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

const WS_ID = 'ws-guard-id'
const WS_SLUG = 'ws-guard'

function baseInput(presetId: string): CreateAutomationInput {
  return {
    name: '守卫任务',
    prompt: '检查',
    scheduleType: 'daily',
    intervalMinutes: 0,
    timeOfDay: ['09:00'],
    channelId: 'ch-guard',
    workspaceId: WS_ID,
    presetId,
  }
}

describe('自动任务写入拒绝停用的预设', () => {
  test('启用的预设可以写入自动任务', () => {
    const preset = presets.createGlobalAgentPreset({ name: '启用中', description: '' })
    presets.enableGlobalPresetInWorkspace(WS_SLUG, { presetId: preset.id, presetScope: 'user-global' })
    expect(() => automations.createAutomation(baseInput(preset.id))).not.toThrow()
  })

  test('无工作区上下文时携带预设必须拒绝，草稿不能保存未校验的预设引用', () => {
    const preset = presets.createGlobalAgentPreset({ name: '草稿预设', description: '' })
    presets.enableGlobalPresetInWorkspace(WS_SLUG, { presetId: preset.id, presetScope: 'user-global' })
    const { workspaceId: _omit, ...withoutWorkspace } = baseInput(preset.id)
    expect(() => automations.createAutomation(withoutWorkspace)).toThrow('指定预设前需要先选择工作区')
    expect(automations.listAutomations().some((item) => item.presetId === preset.id)).toBe(false)
  })

  test('在当前工作区停用的预设：创建自动任务必须抛错，且不落盘', () => {
    const preset = presets.createGlobalAgentPreset({ name: '已停用', description: '' })
    presets.enableGlobalPresetInWorkspace(WS_SLUG, { presetId: preset.id, presetScope: 'user-global' })
    presets.disableGlobalPresetInWorkspace(WS_SLUG, { presetId: preset.id, presetScope: 'user-global' })

    expect(() => automations.createAutomation(baseInput(preset.id))).toThrow()
    expect(automations.listAutomations().some((item) => item.presetId === preset.id)).toBe(false)
  })
})
