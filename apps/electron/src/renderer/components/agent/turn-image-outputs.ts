/** 从一轮消息里收集「图片输出工具 → 图片附件」，供渲染层把图片提升为回复内容。 */
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@profer/shared'
import {
  isAgentImageOutputToolName,
  parseAgentImageAttachmentDetails,
  type ParsedAgentImageAttachment,
} from './image-attachment-marker'

function collectImageOutputToolUseIds(messages: SDKMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const assistantMessage = message as SDKAssistantMessage
    // 子 Agent 的图片调用留在它自己的工具块内，不提升到主回复。
    if (assistantMessage.parent_tool_use_id) continue
    for (const block of assistantMessage.message?.content ?? []) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
      if (isAgentImageOutputToolName(block.name)) ids.add(block.id)
    }
  }
  return ids
}

/**
 * 图片只认工具结果顶层的结构化 details，不依赖模型在正文里回显标记。
 * 返回 Map 的顺序不参与渲染；渲染顺序由工具调用在消息里的位置决定。
 */
export function collectTurnImageOutputs(messages: SDKMessage[]): Map<string, ParsedAgentImageAttachment[]> {
  const imageToolUseIds = collectImageOutputToolUseIds(messages)
  if (imageToolUseIds.size === 0) return new Map()

  const outputs = new Map<string, ParsedAgentImageAttachment[]>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    const userMessage = message as SDKUserMessage
    if (userMessage.parent_tool_use_id) continue
    const content = userMessage.message?.content
    if (!Array.isArray(content)) continue

    const rawMessage = userMessage as unknown as Record<string, unknown>
    const images = parseAgentImageAttachmentDetails(rawMessage.tool_use_result ?? rawMessage.toolUseResult)
    if (images.length === 0) continue

    for (const block of content) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      if (imageToolUseIds.has(block.tool_use_id)) outputs.set(block.tool_use_id, images)
    }
  }
  return outputs
}
