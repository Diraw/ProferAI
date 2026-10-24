/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 已归档）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** 侧边栏视图模式 */
export type SidebarViewMode = 'active' | 'archived'

/** 侧边栏视图模式（active = 显示活跃对话，archived = 显示已归档对话） */
export const sidebarViewModeAtom = atom<SidebarViewMode>('active')

/**
 * 左侧栏顶部「当前会话」区域是否显示。
 *
 * 默认显示；关闭后不渲染该区，会话本身与项目列表都不受影响。
 * 属于纯界面偏好，和宽度/高度一样持久化到 localStorage。
 */
export const showCurrentSessionSectionAtom = atomWithStorage<boolean>(
  'profer-sidebar-show-current-session',
  true,
)

/** 项目列表排序方式 */
export type WorkspaceSortMode = 'default' | 'recent' | 'name'

/** 项目列表排序方式（default = 默认/创建时间，recent = 最近更新，name = 名称） */
export const workspaceSortModeAtom = atomWithStorage<WorkspaceSortMode>(
  'profer-workspace-sort-mode',
  'default',
)

/** 项目列表高度（px），用户可拖拽调整，持久化到 localStorage */
export const projectListHeightAtom = atomWithStorage<number>(
  'profer-workspace-list-height',
  120,
)

/**
 * 左侧栏「列表」宽度（px），用户可拖拽调整，持久化到 localStorage。
 *
 * 语义：只表示 rail 右侧的列表宽度，不含 54px 常驻 rail。外壳总宽 = 54 + 该值，
 * 默认 246 → 总宽 300，与 lib/panel-layout.ts 的 SIDEBAR_WIDTH 预算一致。
 * 因为语义从「总宽」改成「列表宽」，storage key 升到 v2，避免老用户读到 300 变成 354。
 */
export const leftSidebarWidthAtom = atomWithStorage<number>(
  'profer-left-sidebar-width-v2',
  246,
)
