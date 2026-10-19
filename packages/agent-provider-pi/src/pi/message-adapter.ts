/**
 * Pi Agent 消息兼容层。
 *
 * 宿主共享的消息协议保持 Claude SDK 兼容；本模块集中处理
 * Pi AgentMessage 与 SDKMessage 之间的形状转换，避免 session 编排代码混入 UI 协议细节。
 */

import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai/compat'
import type { SDKMessage, SDKAssistantMessage } from '@profer/shared'
import type { RuntimeGuardResultOverride } from '@profer/agent-runtime'
import { isTransientNetworkError } from '@profer/agent-runtime/error-patterns'
import type { PiImageTranscodeOptions, PiImageTranscodeResult, PiImageTranscoderPort } from '../ports'

function getPiEditItems(input: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(input.edits)
    ? input.edits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

function isMultiEditInput(piName: string, input: Record<string, unknown>): boolean {
  return piName === 'edit' && getPiEditItems(input).length > 1
}

export function displayToolName(piName: string, input?: Record<string, unknown>): string {
  switch (piName) {
    case 'read':
      return 'Read'
    case 'write':
      return 'Write'
    case 'edit':
      return input && isMultiEditInput(piName, input) ? 'MultiEdit' : 'Edit'
    case 'bash':
      return 'Bash'
    case 'grep':
      return 'Grep'
    case 'find':
      return 'Glob'
    case 'ls':
      return 'LS'
    default:
      return piName
  }
}

export function normalizePermissionInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      return {
        ...input,
        file_path: input.path,
        edits: editItems.map((edit) => ({
          ...edit,
          old_string: edit.old_string ?? edit.oldText,
          new_string: edit.new_string ?? edit.newText,
        })),
        old_string: firstEdit?.old_string ?? firstEdit?.oldText,
        new_string: firstEdit?.new_string ?? firstEdit?.newText,
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.path ?? '.' }
    default:
      return input
  }
}

function normalizeToolUseInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.file_path ?? input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      const normalizedEdits = editItems.map((edit) => ({
        ...edit,
        old_string: edit.old_string ?? edit.oldText,
        new_string: edit.new_string ?? edit.newText,
      }))
      const joinedOld = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.old_string ?? '')}`)
        .join('\n')
      const joinedNew = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.new_string ?? '')}`)
        .join('\n')
      return {
        ...input,
        file_path: input.file_path ?? input.path,
        edits: normalizedEdits,
        old_string: input.old_string ?? (normalizedEdits.length > 1 ? joinedOld : firstEdit?.old_string ?? firstEdit?.oldText),
        new_string: input.new_string ?? (normalizedEdits.length > 1 ? joinedNew : firstEdit?.new_string ?? firstEdit?.newText),
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.file_path ?? input.path ?? '.' }
    default:
      return input
  }
}

export function restorePiInput(
  piName: string,
  original: Record<string, unknown>,
  updated?: Record<string, unknown>,
): Record<string, unknown> {
  if (!updated) return original
  switch (piName) {
    case 'read':
    case 'write':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    case 'edit':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    default:
      return { ...original, ...updated }
  }
}

export const EMPTY_IMAGE_PLACEHOLDER_TEXT = '[图像内容不可用：工具返回了空图像数据，已从发送给模型的上下文中移除。请改用文本方式获取信息（例如 BrowserObserve）。]'

/**
 * 工具结果上下文预算。
 *
 * 审计依据（2026-10-19，近 14 天 349 个 Pi 会话、30,716 次模型调用）：
 * 工具结果占上下文字符的 88%，其中 bash/read/grep 是文本大头，inspect_preview
 * 的截图是图片大头。Pi SDK 已按 50KB/2000 行截断单次工具输出，但旧结果会在
 * 后续每次请求里重复进入上下文，长会话因此膨胀到 9 万 token/次以上。
 *
 * 策略：
 * - 最近 2 条工具结果保持完整；更早的文本压到 8k 字符（保留头尾）。
 * - 图片按“新旧分层 + 总 base64 字节”分配：最近 2 张高清，其余保留图低清；
 *   总预算超限时从最旧开始省略。旧内容可随时重新读取/重跑工具。
 * - 宿主注入 imageTranscoder 时，旧图会先降采样/转 JPEG 再发送；没有转码器时
 *   退化为张数裁剪，至少不会把无限图片塞进请求。
 */
const KEEP_RECENT_TOOL_RESULTS = 2
const MAX_OLD_TOOL_RESULT_TEXT_CHARS = 8_000
const MAX_CONTEXT_IMAGES = 6
/** 请求中所有工具图片 base64 字符数的总预算（约 4.5MB 原始字节）。 */
const MAX_CONTEXT_IMAGE_BASE64_BYTES = 6 * 1024 * 1024
/** 最近两张图保留更高分辨率；其余旧图降为缩略图。 */
const HIGH_RES_IMAGE_COUNT = 2
const HIGH_RES_IMAGE_OPTIONS: PiImageTranscodeOptions = {
  maxSide: 1600,
  quality: 82,
  maxBase64Bytes: 1_500_000,
}
const OLD_IMAGE_OPTIONS: PiImageTranscodeOptions = {
  maxSide: 1024,
  quality: 70,
  maxBase64Bytes: 300_000,
}

export const TOOL_RESULT_BUDGET_MARKER = '[Profer context budget:'
export const OMITTED_TOOL_IMAGE_TEXT = '[Profer context budget: 已省略较早的工具图片以节省上下文；如需查看，请重新调用对应工具。]'

function truncateToolResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars || text.includes(TOOL_RESULT_BUDGET_MARKER)) return text
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = maxChars - headChars
  const omitted = text.length - maxChars
  return `${text.slice(0, headChars)}\n\n${TOOL_RESULT_BUDGET_MARKER} 已省略 ${omitted} 个字符以节省上下文；如仍需完整内容，请重新调用工具或分页读取。]\n\n${text.slice(-tailChars)}`
}

function budgetToolResultText(content: unknown, maxTextChars: number | null): unknown | null {
  if (maxTextChars === null) return null

  if (typeof content === 'string') {
    const truncated = truncateToolResultText(content, maxTextChars)
    return truncated === content ? null : truncated
  }

  if (!Array.isArray(content)) return null

  const blocks = content as Array<Record<string, unknown>>
  const textBlocks = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string')
  const totalTextChars = textBlocks.reduce((total, block) => total + String(block.text).length, 0)
  if (totalTextChars <= maxTextChars) return null

  const combined = textBlocks.map((block) => String(block.text)).join('\n')
  const truncated = truncateToolResultText(combined, maxTextChars)
  const firstTextIndex = blocks.findIndex((block) => block.type === 'text')
  if (firstTextIndex < 0) return [...blocks, { type: 'text', text: truncated }]

  const before = blocks.slice(0, firstTextIndex).filter((block) => block.type !== 'text')
  const after = blocks.slice(firstTextIndex + 1).filter((block) => block.type !== 'text')
  return [...before, { type: 'text', text: truncated }, ...after]
}

function budgetToolResultImagesByCount(content: unknown, keepImages: number): unknown | null {
  if (!Array.isArray(content)) return null

  const blocks = content as Array<Record<string, unknown>>
  const imageCount = blocks.reduce((count, block) => count + (block.type === 'image' ? 1 : 0), 0)
  if (imageCount <= keepImages) return null

  const omitted = imageCount - keepImages
  let keptImages = 0
  let insertedNote = false
  const output: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (block.type !== 'image') {
      output.push(block)
      continue
    }
    if (keptImages < keepImages) {
      output.push(block)
      keptImages += 1
    } else if (!insertedNote) {
      output.push({ type: 'text', text: `${OMITTED_TOOL_IMAGE_TEXT}（${omitted} 张）` })
      insertedNote = true
    }
  }
  return output
}

function toolResultImageCount(message: AgentMessage): number {
  const content = (message as ToolResultMessage).content as unknown
  if (!Array.isArray(content)) return 0
  return content.reduce((count, block) => {
    return count + (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'image' ? 1 : 0)
  }, 0)
}

function applyTextBudget(messages: AgentMessage[]): { messages: AgentMessage[]; changed: boolean } {
  const toolResultIndices: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if ((messages[index] as { role?: unknown } | undefined)?.role === 'toolResult') toolResultIndices.push(index)
  }
  if (toolResultIndices.length === 0) return { messages, changed: false }

  let changed = false
  const next = [...messages]

  // 从最新到最旧分配文本预算；最近两条工具结果保持完整，避免影响当前推理。
  for (let order = toolResultIndices.length - 1; order >= 0; order -= 1) {
    const index = toolResultIndices[order]
    if (index === undefined) continue
    const message = messages[index] as ToolResultMessage
    const isRecent = order >= toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS
    const budgeted = budgetToolResultText(message.content, isRecent ? null : MAX_OLD_TOOL_RESULT_TEXT_CHARS)
    if (budgeted === null) continue
    next[index] = { ...message, content: budgeted as ToolResultMessage['content'] } as unknown as AgentMessage
    changed = true
  }

  return { messages: changed ? next : messages, changed }
}

/** 同步预算：只做文本截断和张数裁剪，保留原有调用方/测试行为。 */
export function budgetPiToolResults(messages: AgentMessage[]): AgentMessage[] {
  const textBudget = applyTextBudget(messages)
  const toolResultIndices: number[] = []
  for (let index = 0; index < textBudget.messages.length; index += 1) {
    if ((textBudget.messages[index] as { role?: unknown } | undefined)?.role === 'toolResult') toolResultIndices.push(index)
  }
  if (toolResultIndices.length === 0) return textBudget.messages

  let remainingImages = MAX_CONTEXT_IMAGES
  let changed = textBudget.changed
  const next = [...textBudget.messages]

  // 从最新到最旧分配图片预算；最近两条工具结果保持完整文本，避免影响当前推理。
  for (let order = toolResultIndices.length - 1; order >= 0; order -= 1) {
    const index = toolResultIndices[order]
    if (index === undefined) continue
    const message = textBudget.messages[index] as ToolResultMessage
    const imageCount = toolResultImageCount(message)
    const keepImages = Math.min(imageCount, remainingImages)
    remainingImages -= keepImages

    const budgeted = budgetToolResultImagesByCount(message.content, keepImages)
    if (budgeted === null) continue
    changed = true
    next[index] = { ...message, content: budgeted as ToolResultMessage['content'] } as unknown as AgentMessage
  }

  return changed ? next : messages
}

type ToolResultBlock = Record<string, unknown>
type ImageReplacementMap = Map<number, Map<number, ToolResultBlock | null>>

/**
 * 按原始 image block 对象缓存转码结果。
 *
 * prepareNextTurnWithContext 返回的是请求快照，不会改写 Pi 会话里的原始消息；
 * 同一张图每轮都会重新进入预算。WeakMap 以原始 block 为键，既避免每轮重复编码，
 * 又不会在会话结束后持有图片内存。
 */
const imageTranscodeCache = new WeakMap<object, Map<string, PiImageTranscodeResult | null>>()

function transcodeCacheKey(options: PiImageTranscodeOptions): string {
  return `${options.maxSide}:${options.quality}:${options.maxBase64Bytes}`
}

interface ImageSlot {
  messageIndex: number
  blockIndex: number
  block: ToolResultBlock
}

function collectImageSlots(messages: AgentMessage[]): ImageSlot[] {
  const slots: ImageSlot[] = []
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    const role = (message as { role?: unknown } | undefined)?.role
    // 工具结果是主路径；user 消息也纳入，覆盖未来 session.prompt(images) 或桥接入口。
    if (!message || (role !== 'toolResult' && role !== 'user')) continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex]
      if (!block || typeof block !== 'object') continue
      const record = block as ToolResultBlock
      if (record.type === 'image' && typeof record.data === 'string' && record.data.length > 0) {
        slots.push({ messageIndex, blockIndex, block: record })
      }
    }
  }
  // 最新消息优先；同一消息内保持原始顺序，让多页预览的前几页优先拿高清。
  slots.sort((a, b) => b.messageIndex - a.messageIndex || a.blockIndex - b.blockIndex)
  return slots
}

function setImageReplacement(
  replacements: ImageReplacementMap,
  messageIndex: number,
  blockIndex: number,
  replacement: ToolResultBlock | null,
): void {
  let blocks = replacements.get(messageIndex)
  if (!blocks) {
    blocks = new Map()
    replacements.set(messageIndex, blocks)
  }
  blocks.set(blockIndex, replacement)
}

async function transcodeImageSlot(
  slot: ImageSlot,
  options: PiImageTranscodeOptions,
  transcoder?: PiImageTranscoderPort,
): Promise<ToolResultBlock> {
  if (!transcoder) return slot.block
  const cacheKey = transcodeCacheKey(options)
  const cachedByTier = imageTranscodeCache.get(slot.block)
  if (cachedByTier?.has(cacheKey)) {
    const cached = cachedByTier.get(cacheKey)
    return cached
      ? { ...slot.block, data: cached.data, mimeType: cached.mimeType }
      : slot.block
  }

  const currentData = String(slot.block.data)
  const currentMimeType = typeof slot.block.mimeType === 'string' ? slot.block.mimeType : 'image/png'
  let result: PiImageTranscodeResult | null = null
  try {
    const transcoded = await transcoder.transcode({ data: currentData, mimeType: currentMimeType }, options)
    // 转码结果反而更大时缓存 null，下一轮直接保留原图，避免为了“压缩”把请求撑大。
    if (transcoded && typeof transcoded.data === 'string' && transcoded.data.length > 0 && transcoded.data.length < currentData.length) {
      result = {
        data: transcoded.data,
        mimeType: typeof transcoded.mimeType === 'string' ? transcoded.mimeType : 'image/jpeg',
      }
    }
  } catch {
    result = null
  }

  let cache = imageTranscodeCache.get(slot.block)
  if (!cache) {
    cache = new Map()
    imageTranscodeCache.set(slot.block, cache)
  }
  cache.set(cacheKey, result)

  return result ? { ...slot.block, data: result.data, mimeType: result.mimeType } : slot.block
}

function applyImageReplacements(messages: AgentMessage[], replacements: ImageReplacementMap): AgentMessage[] {
  if (replacements.size === 0) return messages

  let changed = false
  const next = [...messages]
  for (const [messageIndex, blockReplacements] of replacements) {
    const message = messages[messageIndex] as { content?: unknown } | undefined
    if (!message) continue
    const content = message.content
    if (!Array.isArray(content)) continue

    let omitted = 0
    const output: ToolResultBlock[] = []
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex] as ToolResultBlock
      if (block && block.type === 'image' && blockReplacements.has(blockIndex)) {
        const replacement = blockReplacements.get(blockIndex)
        if (replacement) output.push(replacement)
        else omitted += 1
        continue
      }
      output.push(block)
    }
    if (omitted > 0) output.push({ type: 'text', text: `${OMITTED_TOOL_IMAGE_TEXT}（${omitted} 张）` })
    next[messageIndex] = { ...message, content: output } as unknown as AgentMessage
    changed = true
  }
  return changed ? next : messages
}

/**
 * 异步预算：文本截断 + 图片新旧分层 + 总 base64 字节上限。
 *
 * 最近两张图走高清档（1600px/JPEG 82），其余保留图走缩略档（1024px/JPEG 70）；
 * 总数超过 6 张或总字节超过预算时，从最旧开始替换成省略说明。
 */
export async function budgetPiToolResultsWithImages(
  messages: AgentMessage[],
  transcoder?: PiImageTranscoderPort,
): Promise<AgentMessage[]> {
  const textBudget = applyTextBudget(messages)
  const textBudgeted = textBudget.messages
  const slots = collectImageSlots(textBudgeted)
  if (slots.length === 0) return textBudgeted

  const replacements: ImageReplacementMap = new Map()
  const kept = slots.slice(0, MAX_CONTEXT_IMAGES)
  for (const slot of slots.slice(MAX_CONTEXT_IMAGES)) {
    setImageReplacement(replacements, slot.messageIndex, slot.blockIndex, null)
  }

  const processed: Array<{ slot: ImageSlot; block: ToolResultBlock }> = []
  let totalBase64 = 0
  for (let index = 0; index < kept.length; index += 1) {
    const slot = kept[index]
    if (!slot) continue
    const options = index < HIGH_RES_IMAGE_COUNT ? HIGH_RES_IMAGE_OPTIONS : OLD_IMAGE_OPTIONS
    const block = await transcodeImageSlot(slot, options, transcoder)
    processed.push({ slot, block })
    totalBase64 += String(block.data).length
  }

  // 总字节预算：从最旧的保留图开始省略，避免 6 张高清图仍撞上网关 body 上限。
  while (totalBase64 > MAX_CONTEXT_IMAGE_BASE64_BYTES && processed.length > 1) {
    const dropped = processed.pop()
    if (!dropped) break
    totalBase64 -= String(dropped.block.data).length
    setImageReplacement(replacements, dropped.slot.messageIndex, dropped.slot.blockIndex, null)
  }

  // 只剩最新一张仍超预算：再降一档，而不是直接把当前正在看的图删掉。
  if (totalBase64 > MAX_CONTEXT_IMAGE_BASE64_BYTES && processed.length === 1 && transcoder) {
    const single = processed[0]
    if (single) {
      const emergency = await transcodeImageSlot(
        single.slot,
        { maxSide: 800, quality: 60, maxBase64Bytes: 300_000 },
        transcoder,
      )
      if (String(emergency.data).length < totalBase64) {
        processed[0] = { slot: single.slot, block: emergency }
        setImageReplacement(replacements, single.slot.messageIndex, single.slot.blockIndex, emergency)
      }
    }
  }

  for (const { slot, block } of processed) {
    if (block !== slot.block) {
      setImageReplacement(replacements, slot.messageIndex, slot.blockIndex, block)
    }
  }

  return applyImageReplacements(textBudgeted, replacements)
}

function isEmptyImageBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const record = block as Record<string, unknown>
  if (record.type !== 'image') return false
  return typeof record.data !== 'string' || record.data.length === 0
}

function replaceEmptyImageBlocks(messages: AgentMessage[]): AgentMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'toolResult') return message
    const toolResult = message as ToolResultMessage
    const content = toolResult.content as unknown
    if (!Array.isArray(content) || !content.some(isEmptyImageBlock)) return message
    changed = true
    return {
      ...toolResult,
      content: content.map((block) => (isEmptyImageBlock(block) ? { type: 'text', text: EMPTY_IMAGE_PLACEHOLDER_TEXT } : block)),
    } as unknown as AgentMessage
  })
  return changed ? next : messages
}

/**
 * 请求前历史消毒：工具若把空图像块（例如视图不可见时 capturePage 返回的空截图）写进会话历史，
 * 部分模型上游收到带空 data 的 image part 会挂起直到客户端超时（实测 kimi-k3 每次 ~105s 无响应
 * 后被自动重试，表现为“模型连不上”式死循环）。每轮构建请求前把空图像块替换为文本说明，
 * 既保护新写入的历史，也让已被污染的既有会话恢复可用。无空图时原样返回（不复制数组）。
 */
export function sanitizePiContextMessages(messages: AgentMessage[]): AgentMessage[] {
  return budgetPiToolResults(replaceEmptyImageBlocks(messages))
}

/** 请求前历史消毒 + 图片分层压缩；Pi adapter 的实际入口。 */
export async function sanitizePiContextMessagesWithImages(
  messages: AgentMessage[],
  transcoder?: PiImageTranscoderPort,
): Promise<AgentMessage[]> {
  return budgetPiToolResultsWithImages(replaceEmptyImageBlocks(messages), transcoder)
}

/** transformContext 所需的最小 agent 面；便于单测不构造完整 Pi 会话。 */
export interface PiContextTransformAgent {
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
}

/**
 * 把图片预算挂到 Pi 的 transformContext。
 *
 * 这是每次模型请求都会经过的入口（含恢复会话后的第一轮）；相比
 * prepareNextTurnWithContext 只覆盖 lastCompletedTurn 之后的轮次，它不会漏掉首轮。
 * 若 SDK/其他扩展已设置 transformContext，则先执行原逻辑再压缩。
 */
export function installPiContextBudget(agent: PiContextTransformAgent, transcoder?: PiImageTranscoderPort): void {
  const previousTransformContext = agent.transformContext
  agent.transformContext = async (messages, signal) => {
    const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages
    return sanitizePiContextMessagesWithImages(Array.isArray(transformed) ? transformed : messages, transcoder)
  }
}

function normalizeToolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((item) => {
    if (!item || typeof item !== 'object') return item
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return { type: 'text', text: record.text }
    }
    if (record.type === 'image') {
      return record
    }
    return record
  })
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    }).join('')
  }
  return ''
}

export function isAssistantPiMessage(message: AgentMessage): message is AssistantMessage {
  return !!message && typeof message === 'object' && 'role' in message && message.role === 'assistant'
}

export function isAbortedAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return isAssistantPiMessage(message) && message.stopReason === 'aborted'
}

export function dropTrailingAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages[messages.length - 1]
  return lastMessage && isAbortedAssistantMessage(lastMessage) ? messages.slice(0, -1) : messages
}

export const EMPTY_OUTPUT_ERROR_MESSAGE = '模型未生成可见回复'

function hasVisiblePiAssistantOutput(message: AssistantMessage): boolean {
  return message.content.some((block) => {
    if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0
    return block.type === 'toolCall'
  })
}

function usageFromAssistant(message: AssistantMessage): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} {
  return {
    input_tokens: message.usage?.input ?? 0,
    output_tokens: message.usage?.output ?? 0,
    cache_read_input_tokens: message.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: message.usage?.cacheWrite ?? 0,
  }
}

// 说明：本函数产出的消息 parent_tool_use_id 恒为 null。Pi 的事件模型（AgentEvent）不存在
// 子代理/sidechain 概念，AgentMessage 也无父子关联字段，故 pi 会话的所有消息都是主线。
// 旧 Claude SDK 持久化的会话可能带非空 parent_tool_use_id；宿主仍需兼容其父子消息关联。
export function convertPiMessage(
  message: AgentMessage,
  sessionId: string,
  channelModelId?: string,
  options: { final?: boolean; uuid?: string } = {},
): SDKMessage | null {
  const final = options.final ?? true
  if (!message || typeof message !== 'object' || !('role' in message)) return null

  if (message.role === 'user') {
    const user = message as UserMessage
    return {
      type: 'user',
      message: {
        content: [{ type: 'text', text: contentToText(user.content) }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      ...(final && { uuid: options.uuid ?? randomUUID() }),
    } as unknown as SDKMessage
  }

  if (message.role === 'assistant') {
    const assistant = message as AssistantMessage
    // 只有 stopReason === 'error' 时才把 errorMessage 提升为终态 error 字段。
    // - 'aborted' 属于用户/系统主动中断，不是失败，弹「服务繁忙 + 重试」在语义上完全错误。
    // - 'stop' / 'length' / 'toolUse' 即使带 errorMessage 也只是 provider 中途抖动，
    //   Pi SDK 认定本轮已成功，不应在渲染层误导用户。
    // 上述非终态情况的 errorMessage 只写主进程 console，供开发排查；用户侧完全无感知。
    const isTerminalError = assistant.stopReason === 'error'
    const isEmptyVisibleOutput = final
      && assistant.stopReason !== 'aborted'
      && !assistant.errorMessage
      && !hasVisiblePiAssistantOutput(assistant)
    if (assistant.errorMessage && !isTerminalError && final) {
      console.warn(
        `[pi-adapter] 忽略非终态 errorMessage（stopReason=${assistant.stopReason}）: ${assistant.errorMessage}`,
      )
    }
    return {
      type: 'assistant',
      message: {
        content: assistant.content.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text }
          if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking }
          if (block.type === 'toolCall') {
            return {
              type: 'tool_use',
              id: block.id,
              name: displayToolName(block.name, block.arguments as Record<string, unknown>),
              // Pi 的 toolcall_delta 每帧携带累计 arguments。大 Write content 会随每个 token
              // 反复穿过 IPC、Jotai 和 React；预览帧只需保留工具身份，最终帧再提供完整 input。
              input: final ? normalizeToolUseInput(block.name, block.arguments as Record<string, unknown>) : {},
            }
          }
          return block as unknown as Record<string, unknown>
        }),
        usage: usageFromAssistant(assistant),
        model: assistant.model,
        stop_reason: assistant.stopReason,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
      ...(!final && { _partial: true }),
      ...(assistant.errorMessage && isTerminalError && {
        error: { message: assistant.errorMessage, errorType: isTransientNetworkError(assistant.errorMessage) ? 'network_error' : 'provider_error' },
      }),
      ...(isEmptyVisibleOutput && {
        error: { message: EMPTY_OUTPUT_ERROR_MESSAGE, errorType: 'empty_output' },
        _emptyOutput: true,
      }),
      ...(channelModelId && { _channelModelId: channelModelId }),
    } as unknown as SDKMessage
  }

  if (message.role === 'toolResult') {
    const toolResult = message as ToolResultMessage
    return {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolResult.toolCallId,
          content: normalizeToolResultContent(toolResult.content),
          is_error: toolResult.isError,
        }],
      },
      tool_use_result: toolResult.details,
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    } as unknown as SDKMessage
  }

  return null
}

/**
 * 检测 Pi 终态错误消息是否同时携带有效正文内容（#1268 断流保消息）。
 *
 * 当 Pi 流式输出中途断连时，stopReason='error' 且同时存在
 * errorMessage 和已有部分正文；此时应先将正文作为正常消息展示，
 * 再追加简短错误摘要，而不应把整个正文渲染在红色错误卡片内。
 */
export function hasTerminalErrorWithContent(msg: SDKMessage): boolean {
  if (msg.type !== 'assistant') return false
  const assistant = msg as SDKAssistantMessage
  if (!assistant.error) return false
  const content = assistant.message?.content
  if (!Array.isArray(content) || content.length === 0) return false
  const text = content
    .filter((block) => block.type === 'text' && typeof (block as { text?: string }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n')
    .trim()
  if (!text) return false

  // Pi/OpenAI 上游有时会把同一句错误文案同时放入 content 与 errorMessage。
  // 这不是「断流前已生成的正文」；若误判为正文，编排层会在自动重试尚未结束时
  // 提前渲染红色错误卡，并与 Agent Running 指示器同时存在。
  return text !== assistant.error.message?.trim()
}

/**
 * 从带错误的 SDKMessage 中剥离出纯正文消息（#1268 断流保消息）。
 *
 * 返回 contentMessage（不含 error 字段、保留原 uuid 以覆盖流式部分帧）
 * 和 errorText（用于生成简短错误摘要）。若消息不含正文内容则返回 null。
 */
export function stripErrorFromContentMessage(msg: SDKMessage): { contentMessage: SDKMessage; errorText: string } | null {
  if (!hasTerminalErrorWithContent(msg)) return null
  const assistant = msg as SDKAssistantMessage
  const errorText = assistant.error?.message ?? '流式传输中断'
  // 浅拷贝 message.content 并移除 error 字段，保留 uuid 覆盖流式部分帧
  const contentMessage: SDKMessage = {
    ...msg,
    error: undefined,
    message: {
      ...assistant.message,
      content: assistant.message.content,
    },
  } as unknown as SDKMessage
  // 确保 error 字段被彻底删除（展开运算符可能保留 undefined）
  delete (contentMessage as Record<string, unknown>).error
  return { contentMessage, errorText }
}

export function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: string }> } }).message?.content
  return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
}

export function convertResultMessage(
  messages: AgentMessage[],
  sessionId: string,
  override?: RuntimeGuardResultOverride,
  contextWindow?: number,
  modelId?: string,
  channelModelId?: string,
): SDKMessage {
  const assistants = messages.filter((m): m is AssistantMessage =>
    !!m && typeof m === 'object' && 'role' in m && m.role === 'assistant')
  const costValues = assistants
    .map((msg) => msg.usage?.cost?.total)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const usage = assistants.reduce(
    (acc, msg) => ({
      input_tokens: acc.input_tokens + (msg.usage?.input ?? 0),
      output_tokens: acc.output_tokens + (msg.usage?.output ?? 0),
      cache_read_input_tokens: acc.cache_read_input_tokens + (msg.usage?.cacheRead ?? 0),
      cache_creation_input_tokens: acc.cache_creation_input_tokens + (msg.usage?.cacheWrite ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  )
  const lastAssistant = assistants[assistants.length - 1]
  const assistantError = lastAssistant?.errorMessage
  const isEmptyVisibleOutput = Boolean(
    lastAssistant
    && lastAssistant.stopReason !== 'aborted'
    && !hasVisiblePiAssistantOutput(lastAssistant)
    && !assistantError,
  )
  const terminalReason = override?.terminalReason ?? (
    isEmptyVisibleOutput
      ? 'empty_output'
      : lastAssistant?.stopReason === 'length'
        ? 'max_tokens'
        : 'completed'
  )
  return {
    type: 'result',
    subtype: override?.subtype ?? (isEmptyVisibleOutput ? 'error_during_execution' : assistantError ? 'error_during_execution' : terminalReason === 'max_tokens' ? 'max_tokens' : 'success'),
    usage,
    total_cost_usd: costValues.length > 0 ? costValues.reduce((sum, cost) => sum + cost, 0) : undefined,
    ...(contextWindow != null && { modelUsage: { [modelId ?? channelModelId ?? 'default']: { contextWindow } } }),
    ...((channelModelId ?? modelId) && { _channelModelId: channelModelId ?? modelId }),
    terminal_reason: terminalReason,
    errors: override?.errors ?? (isEmptyVisibleOutput ? [EMPTY_OUTPUT_ERROR_MESSAGE] : assistantError ? [assistantError] : undefined),
    session_id: sessionId,
  } as unknown as SDKMessage
}
