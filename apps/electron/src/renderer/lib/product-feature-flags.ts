import type { AgentWorkspace } from '@profer/shared'

/**
 * 暂时隐藏团队工作区的产品开关。
 *
 * 这里只控制 renderer 的产品入口，不删除团队数据、IPC 或服务端能力；
 * 后续恢复时只需改回 true 并重新构建即可。
 */
export const TEAM_WORKSPACE_UI_ENABLED = false

export function isAgentWorkspaceVisible(workspace: Pick<AgentWorkspace, 'type'>): boolean {
  return TEAM_WORKSPACE_UI_ENABLED || workspace.type !== 'team'
}

export function getVisibleAgentWorkspaces<T extends Pick<AgentWorkspace, 'type'>>(
  workspaces: readonly T[],
): T[] {
  return TEAM_WORKSPACE_UI_ENABLED
    ? [...workspaces]
    : workspaces.filter((workspace) => workspace.type !== 'team')
}

export function isAgentWorkspaceIdVisible(
  workspaceId: string | null | undefined,
  workspaces: readonly Pick<AgentWorkspace, 'id' | 'type'>[],
): boolean {
  if (!workspaceId) return true
  const workspace = workspaces.find((item) => item.id === workspaceId)
  return !workspace || isAgentWorkspaceVisible(workspace)
}
