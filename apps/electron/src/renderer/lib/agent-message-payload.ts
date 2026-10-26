import type { QuotedSelection } from '@/atoms/preview-atoms'
import { buildQuotedSelectionsPrefix } from '@/lib/quoted-selection'

/**
 * 发送前的文本拼装：正文 + 待发送引用列表 → 最终交给主进程的文本。
 *
 * 引用列表是会话级待发送缓冲（见 `quotedSelectionsMapAtom`），发送时整组消费；
 * 这里只负责按列表顺序把引用块前缀拼到正文前面，不持有任何队列状态。
 */

/**
 * 剥离 Electron `ipcRenderer.invoke` 给主进程错误加上的包装前缀：
 * `Error invoking remote method '<channel>': Error: <主进程文案>`。
 *
 * 主进程抛出的文案本身不带前缀，所以对 `error.message` 做锚定匹配会在真实 IPC 上永远失配
 * （同一前缀的剥离写法已存在于 FileBrowser.stripIpcErrorPrefix）。
 */
function stripIpcErrorPrefix(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

/** Main 已结束旧 run、renderer 尚未收到 complete 时，可安全降级为新 run。 */
export function isQueueTargetNoLongerActiveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^\[Agent 编排\] 会话未运行，无法追加消息: /.test(stripIpcErrorPrefix(error.message))
}

/** Main 确认本次请求未启动、同 session 的 owner run 仍在执行。 */
export function isAgentRunAlreadyActiveError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^AGENT_RUN_ALREADY_ACTIVE: /.test(stripIpcErrorPrefix(error.message))
}

const REF_PATTERN = /\/skill:(?<skill>\S+)|#mcp:(?<mcp>\S+)|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)\S+)?/g

export interface ParsedMessageMentions {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
}

export function parseMessageMentions(text: string): ParsedMessageMentions {
  const mentionedSkills: string[] = []
  const mentionedMcpServers: string[] = []
  const mentionedSessionIds: string[] = []

  for (const match of text.matchAll(REF_PATTERN)) {
    const { skill, mcp, session } = match.groups ?? {}
    if (skill) mentionedSkills.push(skill)
    else if (mcp) mentionedMcpServers.push(mcp)
    else if (session) mentionedSessionIds.push(session)
  }

  return {
    cleanedText: text.replace(REF_PATTERN, '').trim(),
    mentionedSkills,
    mentionedMcpServers,
    mentionedSessionIds,
  }
}

export interface AgentMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: ParsedMessageMentions
}

/**
 * 拼装最终发送文本：顺序固定为「引用块们 → 正文」。
 *
 * `rawText` 保留 mention 原文（用于持久化气泡展示），`sdkText` 剥掉 mention 标记
 * （模型只需要结构化字段，不需要 `/skill:` 这类前缀）。
 */
export function buildAgentMessagePayload(
  text: string,
  quotedSelections: readonly QuotedSelection[] = [],
): AgentMessageSendPayload {
  const trimmed = text.trim()
  const mentions = parseMessageMentions(trimmed)
  const prefix = buildQuotedSelectionsPrefix(quotedSelections)

  return {
    rawText: `${prefix}${trimmed}`.trim(),
    sdkText: `${prefix}${mentions.cleanedText}`.trim(),
    mentions,
  }
}
