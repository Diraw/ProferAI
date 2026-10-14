import type { AgentWorkspace } from '@profer/shared'

/** 判断工作区是否进入产品入口；团队工作区已不再是有效的产品类型。 */
export function isAgentWorkspaceVisible(
  workspace: Pick<AgentWorkspace, 'type'> & { archived?: boolean },
): boolean {
  return !workspace.archived
}

export function getVisibleAgentWorkspaces<
  T extends Pick<AgentWorkspace, 'type'> & { archived?: boolean },
>(workspaces: readonly T[]): T[] {
  return workspaces.filter((workspace) => isAgentWorkspaceVisible(workspace))
}

export function isAgentWorkspaceIdVisible(
  workspaceId: string | null | undefined,
  workspaces: readonly (Pick<AgentWorkspace, 'id' | 'type'> & { archived?: boolean })[],
): boolean {
  if (!workspaceId) return true
  const workspace = workspaces.find((item) => item.id === workspaceId)
  return !workspace || isAgentWorkspaceVisible(workspace)
}
