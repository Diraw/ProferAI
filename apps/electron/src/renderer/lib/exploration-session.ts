import type { AgentRuntime, SDKMessage } from '@profer/shared'

export interface ExplorationReferenceDraft {
  markdown: string
  html: string
}

/**
 * 回复操作栏两个「分叉类」动作的可用性。
 *
 * 两者语义不同，不能合并：
 * - fork：从某条回复重建一个独立的顶层会话（会话损坏救援 / 换模型接续），所有 runtime 都支持。
 * - explore：Pi `/tree` 探索分支，挂在主线右侧血缘下，目前仅 Pi runtime 支持。
 */
export function resolveForkActionAvailability(options: {
  embedded: boolean
  agentRuntime: AgentRuntime | undefined
}): { canFork: boolean; canExplore: boolean } {
  // 嵌入在右侧探索面板里的分支不再提供二级分叉入口。
  if (options.embedded) return { canFork: false, canExplore: false }
  return { canFork: true, canExplore: options.agentRuntime === 'pi' }
}

/** 父会话与右侧探索分支同时挂载时，只有当前可见工作面拥有全局快捷键。 */
export function ownsExplorationShortcut(
  embedded: boolean,
  sessionId: string,
  activeSidePanelTab: string | undefined,
): boolean {
  return embedded
    ? activeSidePanelTab === `exploration:${sessionId}`
    : !activeSidePanelTab?.startsWith('exploration:')
}

/**
 * 从当前可见消息时间线选择最近一个可分叉的 assistant UUID。
 * 消息缓存不完整时，退回 metadata 中最后写入的 binding。
 */
export function resolveLatestExplorationSourceMessageId(
  messages: SDKMessage[],
  bindings: Record<string, string> | undefined,
): string | undefined {
  const boundIds = new Set(Object.keys(bindings ?? {}))
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { type?: unknown; uuid?: unknown; parent_tool_use_id?: unknown }
    if (message.type !== 'assistant' || message.parent_tool_use_id != null) continue
    if (typeof message.uuid === 'string' && boundIds.has(message.uuid)) return message.uuid
  }
  return Object.keys(bindings ?? {}).at(-1)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char)
}

/**
 * 只提取探索锚点之后最新一条有正文的 assistant 回复。
 * fork 前复制的主线历史不会被误当作本次探索结论。
 */
export function getLatestExplorationConclusion(messages: SDKMessage[], sourceMessageId: string): string {
  const sourceIndex = messages.findIndex((message) => (message as { uuid?: unknown }).uuid === sourceMessageId)
  if (sourceIndex < 0) return ''

  for (let index = messages.length - 1; index > sourceIndex; index -= 1) {
    const message = messages[index] as { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } }
    if (message.type !== 'assistant' || message.parent_tool_use_id != null || !Array.isArray(message.message?.content)) continue
    const text = message.message.content
      .flatMap((block) => {
        if (!block || typeof block !== 'object') return []
        const record = block as { type?: unknown; text?: unknown }
        return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
      })
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/** 构造富文本草稿中的受控 session mention，不把探索正文复制进主会话。 */
export function buildExplorationReferenceDraft(branchSessionId: string, branchTitle: string): ExplorationReferenceDraft {
  const label = `探索后新增内容 · ${branchTitle}`
  const safeId = escapeHtml(branchSessionId)
  const safeLabel = escapeHtml(label)
  return {
    markdown: `这是探索后的新增内容：&session:${branchSessionId}::${encodeURIComponent(label)}`,
    html: `<p>这是探索后的新增内容：<span data-type="mention" data-id="${safeId}" data-label="${safeLabel}" data-mention-suggestion-char="&">${safeLabel}</span></p>`,
  }
}
