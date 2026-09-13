import type { SDKMessage } from '@profer/shared'

export interface ExplorationReferenceDraft {
  markdown: string
  html: string
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
