import { describe, expect, test } from 'bun:test'
import { PROFER_PERMISSION_MODE_CONFIG, PROFER_PERMISSION_MODE_ORDER } from '@profer/shared'
import {
  buildPermissionModeMenu,
  canSelectPermissionMode,
  describePermissionModeRestriction,
  resolveSelectorMode,
} from './permission-mode-selector-utils'

/**
 * 权限模式选择器的预设上限门禁（验收 C-4 的代码级证据）。
 *
 * 该门禁是渲染层唯一的防线：主进程 `UPDATE_SESSION_PERMISSION_MODE` 不做上限收敛，
 * 一旦这里放行更宽松的模式，UI 会显示一个与实际运行权限不符的值。
 */
describe('permission-mode-selector-utils', () => {
  test('菜单顺序恒定取自双端同源的 PROFER_PERMISSION_MODE_ORDER', () => {
    for (const cap of PROFER_PERMISSION_MODE_ORDER) {
      expect(buildPermissionModeMenu(cap).map((entry) => entry.mode)).toEqual([...PROFER_PERMISSION_MODE_ORDER])
    }
  })

  test('预设上限为 bypassPermissions 时三种模式都可选', () => {
    expect(buildPermissionModeMenu('bypassPermissions').map((entry) => entry.selectable)).toEqual([true, true, true])
  })

  test('预设上限为 auto 时不可放宽到 bypassPermissions，收紧到 plan 允许', () => {
    expect(canSelectPermissionMode('auto', 'bypassPermissions')).toBe(false)
    expect(canSelectPermissionMode('auto', 'auto')).toBe(true)
    expect(canSelectPermissionMode('auto', 'plan')).toBe(true)
  })

  test('预设上限为 plan 时 auto / bypassPermissions 都不可选（C-4 核心回归）', () => {
    expect(buildPermissionModeMenu('plan')).toEqual([
      { mode: 'auto', selectable: false },
      { mode: 'bypassPermissions', selectable: false },
      { mode: 'plan', selectable: true },
    ])
  })

  test('任一预设上限下，被标为可选的模式都不会被 resolve 收紧', () => {
    for (const cap of PROFER_PERMISSION_MODE_ORDER) {
      for (const entry of buildPermissionModeMenu(cap)) {
        if (!entry.selectable) continue
        expect(resolveSelectorMode(cap, entry.mode)).toBe(entry.mode)
      }
    }
  })

  test('无显式 override 时显示预设上限本身，不回落到全局默认', () => {
    expect(resolveSelectorMode('plan', undefined)).toBe('plan')
    expect(resolveSelectorMode('auto', undefined)).toBe('auto')
  })

  test('有显式 override 时按严格的预设上限收敛', () => {
    expect(resolveSelectorMode('plan', 'bypassPermissions')).toBe('plan')
    expect(resolveSelectorMode('auto', 'bypassPermissions')).toBe('auto')
    expect(resolveSelectorMode('bypassPermissions', 'plan')).toBe('plan')
    expect(resolveSelectorMode('bypassPermissions', 'auto')).toBe('auto')
  })

  test('受限说明文案直接给出预设上限标签，可用于菜单禁用项与越权兜底 toast', () => {
    expect(describePermissionModeRestriction('plan')).toBe(
      `当前预设将权限限制为「${PROFER_PERMISSION_MODE_CONFIG.plan.label}」，不能切换到更宽松的模式`,
    )
  })
})
