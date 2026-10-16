import type {
  AgentEffort,
  AgentPreset,
  AgentSessionMeta,
  AgentThinkingLevel,
  ChatToolInfo,
  ChatToolState,
  ConversationMeta,
  FileDialogResult,
  KnowledgeItem,
  PresetReference,
  ProferPermissionMode,
  ProviderType,
  ReasoningCapability,
} from '@profer/shared'
import type { AgentRuntime } from '@profer/shared'

/** Composer 只依赖宿主 API 的最小契约，避免工具组件依赖完整 ElectronAPI。 */
export type ComposerHostApi = Window['electronAPI']['composer']

function host(): ComposerHostApi {
  return window.electronAPI.composer
}

export function openComposerFileDialog(): Promise<FileDialogResult> {
  return host().chat.openFileDialog()
}

export function openComposerFolderDialog(): Promise<{ path: string; name: string } | null> {
  return host().agent.openFolderDialog()
}

export function listComposerKnowledgeItems(): Promise<KnowledgeItem[]> {
  return host().chat.listKnowledgeItems()
}

export function updateChatComposerModel(id: string, modelId?: string, channelId?: string): Promise<ConversationMeta> {
  return host().chat.updateModel(id, modelId, channelId)
}

export function updateAgentComposerModel(id: string, channelId?: string, modelId?: string): Promise<AgentSessionMeta> {
  return host().agent.updateModel(id, channelId, modelId)
}

export function updateComposerPermissionMode(sessionId: string, mode: ProferPermissionMode, expectedRevision?: number): Promise<AgentSessionMeta> {
  return host().agent.updatePermissionMode(sessionId, mode, expectedRevision)
}

export function updateComposerOpenAIThinkingLevel(sessionId: string, level: AgentThinkingLevel | null): Promise<AgentSessionMeta> {
  return host().agent.updateOpenAIThinkingLevel(sessionId, level)
}

export function updateComposerEffort(sessionId: string, effort: AgentEffort | null): Promise<AgentSessionMeta> {
  return host().agent.updateEffort(sessionId, effort)
}

export function updateComposerRuntime(sessionId: string, runtime: AgentRuntime): Promise<AgentSessionMeta> {
  return host().agent.updateRuntime(sessionId, runtime)
}

export function listComposerPresets(workspaceSlug?: string, includeInactiveGlobal?: boolean): Promise<AgentPreset[]> {
  return host().agent.listPresets(workspaceSlug, includeInactiveGlobal)
}

export function rebindComposerPreset(sessionId: string, reference: PresetReference, expectedRevision?: number): Promise<AgentSessionMeta> {
  return host().agent.rebindPreset(sessionId, reference, expectedRevision)
}

export function listComposerTools(): Promise<ChatToolInfo[]> {
  return host().tools.list()
}

export function updateComposerToolState(toolId: string, state: ChatToolState): Promise<void> {
  return host().tools.updateState(toolId, state)
}

export function getComposerVoiceSettings(): ReturnType<ComposerHostApi['voice']['getSettings']> {
  return host().voice.getSettings()
}

export function toggleComposerVoice(): Promise<void> {
  return host().voice.toggle()
}

export function getComposerReasoningCapability(provider: ProviderType, modelId?: string, baseUrl?: string): Promise<ReasoningCapability | undefined> {
  return host().agent.getReasoningCapability(provider, modelId, baseUrl)
}

export function updateComposerSettings(updates: Parameters<ComposerHostApi['settings']['update']>[0]): ReturnType<ComposerHostApi['settings']['update']> {
  return host().settings.update(updates)
}

export function getComposerGraphSummary(sessionId: string): ReturnType<ComposerHostApi['agent']['getGraphSummary']> {
  return host().agent.getGraphSummary(sessionId)
}

export function attachComposerDirectory(input: Parameters<ComposerHostApi['agent']['attachDirectory']>[0]): ReturnType<ComposerHostApi['agent']['attachDirectory']> {
  return host().agent.attachDirectory(input)
}
