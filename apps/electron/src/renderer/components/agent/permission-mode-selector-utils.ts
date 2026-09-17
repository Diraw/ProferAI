/**
 * 权限模式选择器的纯逻辑层（无 React/Electron 依赖，可直接单测）。
 *
 * 抽出来的唯一动机：预设权限上限门禁是本组件的关键语义（渲染层是唯一阻止用户持久化
 * 一个「比预设上限更宽松」的误导性模式值的地方，见 IPC `UPDATE_SESSION_PERMISSION_MODE`
 * 不做上限收敛），但组件本身依赖 Radix/Jotai，无法在无 DOM 的 bun test 中渲染。
 */

import type { ProferPermissionMode } from '@profer/shared'
import { PROFER_PERMISSION_MODE_CONFIG, PROFER_PERMISSION_MODE_ORDER, resolveEffectivePermissionMode } from '@profer/shared'

/** 候选模式是否能在当前预设上限内生效（更宽松会被 resolve 收紧，视为不可选）。 */
export function canSelectPermissionMode(
  capMode: ProferPermissionMode,
  candidate: ProferPermissionMode,
): boolean {
  return resolveEffectivePermissionMode(capMode, candidate) === candidate
}

/**
 * 当前有效模式：有显式 override 时按预设上限收紧，否则直接显示预设上限本身。
 *
 * `requestedMode === undefined` 表示用户从未显式选择过（只有预设声明的上限生效），
 * 此时不能回落到全局默认值，否则工具栏显示会与实际运行权限脱节。
 */
export function resolveSelectorMode(
  capMode: ProferPermissionMode,
  requestedMode: ProferPermissionMode | undefined,
): ProferPermissionMode {
  return requestedMode === undefined ? capMode : resolveEffectivePermissionMode(capMode, requestedMode)
}

export interface PermissionModeMenuEntry {
  mode: ProferPermissionMode
  /** 超出预设上限时为 false（菜单项渲染为 disabled）。 */
  selectable: boolean
}

/**
 * 菜单项顺序恒定取自 `PROFER_PERMISSION_MODE_ORDER`（双端同源同值），
 * 这里只补充每个候选的「是否可选」标注，不在任一端手写顺序。
 */
export function buildPermissionModeMenu(capMode: ProferPermissionMode): PermissionModeMenuEntry[] {
  return PROFER_PERMISSION_MODE_ORDER.map((mode) => ({
    mode,
    selectable: canSelectPermissionMode(capMode, mode),
  }))
}

/** 超出预设上限时的统一说明文案（菜单 disabled 项与越权兜底 toast 共用一份措辞）。 */
export function describePermissionModeRestriction(capMode: ProferPermissionMode): string {
  return `当前预设将权限限制为「${PROFER_PERMISSION_MODE_CONFIG[capMode].label}」，不能切换到更宽松的模式`
}
