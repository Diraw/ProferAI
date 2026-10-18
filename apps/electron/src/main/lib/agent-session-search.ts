/**
 * Agent 会话消息搜索的纯逻辑：单行 JSONL 匹配、文本抽取与片段裁剪。无文件 IO，便于单测。
 *
 * 流式读取文件与遍历索引仍在 agent-session-manager；这里只负责「给定一行，是否命中、命中片段是什么」。
 * 同时兼容旧 AgentMessage 与新 SDKMessage 两种历史格式。
 */
import type { AgentMessageSearchResult } from '@profer/shared'

export interface AgentJsonlMatch {
  messageId: string
  role: AgentMessageSearchResult['role']
  snippet: string
  matchStart: number
}

/** 从已落盘的消息对象里取出可检索的纯文本；无文本返回空串 */
export function extractTextFromPersistedMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const record = parsed as {
    content?: unknown
    message?: { content?: Array<{ type: string; text?: string }> }
  }

  if (typeof record.content === 'string') {
    return record.content
  }

  if (Array.isArray(record.message?.content)) {
    return record.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n')
  }

  return ''
}

/** 会话内引用搜索使用的片段：命中前后各保留 48 字符 */
export function createSnippet(text: string, matchIndex: number, matchLength: number): string {
  const snippetStart = Math.max(0, matchIndex - 48)
  const snippetEnd = Math.min(text.length, matchIndex + matchLength + 48)
  return (snippetStart > 0 ? '...' : '') +
    text.slice(snippetStart, snippetEnd) +
    (snippetEnd < text.length ? '...' : '')
}

/**
 * 在单行 JSONL 中查找 `queryLower`（调用方已转小写）。
 * 空行、损坏行与无文本内容的行都返回 null，不抛异常。
 * 片段前后各保留 40 字符；前缀省略号计入 matchStart 的偏移（+3）。
 */
export function matchAgentJsonlLine(line: string, queryLower: string, queryLength: number): AgentJsonlMatch | null {
  if (!line.trim()) return null

  let parsed: {
    role?: string
    id?: string
    uuid?: string
    content?: unknown
    message?: { role?: string; id?: string; content?: Array<{ type: string; text?: string }> }
  }
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  const rawRole = parsed.role ?? parsed.message?.role ?? 'assistant'
  // 收窄到 AgentMessageSearchResult.role 允许的联合类型；不在白名单的退化为 assistant
  const role: AgentMessageSearchResult['role'] =
    rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'status'
      ? rawRole
      : 'assistant'
  const messageId = parsed.id ?? parsed.uuid ?? parsed.message?.id ?? ''

  let textContent = ''
  if (typeof parsed.content === 'string') {
    textContent = parsed.content
  } else if (Array.isArray(parsed.message?.content)) {
    textContent = parsed.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n')
  }
  if (!textContent) return null

  const contentLower = textContent.toLowerCase()
  const matchIndex = contentLower.indexOf(queryLower)
  if (matchIndex === -1) return null

  const snippetStart = Math.max(0, matchIndex - 40)
  const snippetEnd = Math.min(textContent.length, matchIndex + queryLength + 40)
  const snippet = (snippetStart > 0 ? '...' : '') +
    textContent.slice(snippetStart, snippetEnd) +
    (snippetEnd < textContent.length ? '...' : '')
  const matchStart = matchIndex - snippetStart + (snippetStart > 0 ? 3 : 0)

  return { messageId, role, snippet, matchStart }
}
