import type { AgentPreset, AgentPresetScope, PresetReference } from '@profer/shared'

export function getSelectablePresetScope(preset: AgentPreset): AgentPresetScope {
  return preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'workspace')
}

export function referenceForSelectablePreset(preset: AgentPreset, workspaceSlug?: string): PresetReference {
  const presetScope = getSelectablePresetScope(preset)
  return {
    presetId: preset.id,
    presetScope,
    ...(presetScope === 'workspace' && workspaceSlug ? { workspaceSlug } : {}),
    ...(preset.version ? { presetVersion: preset.version } : {}),
  }
}

export function selectablePresetMatchesReference(
  preset: AgentPreset,
  reference: PresetReference | undefined,
): boolean {
  return Boolean(
    reference
      && preset.id === reference.presetId
      && getSelectablePresetScope(preset) === reference.presetScope,
  )
}

/**
 * 当前工作区可供选择的预设：明确停用（enabledInWorkspace === false）的项不进入任何选择菜单。
 * 所有选择入口（会话预设、自动任务预设）都应经由这里过滤，避免各自判定而漏掉停用项。
 */
export function selectableAgentPresets(presets: readonly AgentPreset[]): AgentPreset[] {
  return presets.filter((preset) => preset.enabledInWorkspace !== false)
}
