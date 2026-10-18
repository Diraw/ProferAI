/**
 * 「重新生成」锚点解析
 *
 * Agent 会话没有「原地重新生成」原子能力，可复用的是回退：主进程 `rewindSession`
 * 会保留目标 assistant 消息、截断其后全部对话（并按快照恢复工作区文件），
 * 下一次发消息从该点继续（Claude 记录 `resumeAtMessageUuid`，Pi 截断自身 transcript）。
 *
 * 所以要重新生成最后一轮，锚点必须取最后一条用户消息**之前**的主线 assistant 消息：
 * 回退后最后一轮的一问一答被整体删除，再重发同一条用户消息即得到替换性的新回复。
 *
 * 首轮就失败时没有锚点（回退到哪里都保留不下东西），只能清空整段对话——
 * 主进程侧对应 `rewindSession` 省略 `assistantMessageUuid` 的分支。
 *
 * 「修改重发」（`resolveRewriteTarget`）复用同一套锚点规则，只是锚点跟着**被修改的那条**
 * 用户消息走，而不是固定认最后一条。
 */

import type { SDKMessage } from '@profer/shared'
import { isGoalIterationMessage } from '@profer/shared'

interface SDKMessageRecord {
  type?: string
  parent_tool_use_id?: string | null
  isSynthetic?: boolean
  uuid?: string
  message?: {
    content?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 消息 uuid 的可用值；缺失或空串时返回 undefined。 */
function getMessageUuid(message: SDKMessage): string | undefined {
  const uuid = (message as unknown as SDKMessageRecord).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined
}

/**
 * 用户真实输入的文本。
 *
 * tool_result / 子代理消息 / 合成消息返回 null；Goal 自动迭代注入的控制消息
 * 也不算用户发言（与迷你地图、分隔条口径一致）。
 */
export function getUserTextFromSDKMessage(message: SDKMessage): string | null {
  const sdkMessage = message as unknown as SDKMessageRecord
  if (sdkMessage.type !== 'user' || sdkMessage.parent_tool_use_id || sdkMessage.isSynthetic) {
    return null
  }
  if (isGoalIterationMessage(message)) return null

  const content = sdkMessage.message?.content
  if (!Array.isArray(content)) return null
  if (content.some((block) => isRecord(block) && block.type === 'tool_result')) return null

  const texts = content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)

  return texts.length > 0 ? texts.join('\n') : null
}

export type RegenerateTarget =
  | { kind: 'rewind'; userMessage: string; rewindToAssistantUuid: string }
  | { kind: 'reset'; userMessage: string }

/**
 * 错误卡片的「重试」是否应改走重新生成（截断最后一轮再重发）。
 *
 * 必须同时满足：
 * - 该卡片属于**最新一轮**：锚点只按「最后一条用户消息」解析，历史错误卡片如果也走这条路，
 *   会用与该卡片无关的最新一轮做截断。
 * - 会话当前空闲：主进程回退要求会话未在运行（JSONL 并发写入会损坏文件）。
 *
 * 不满足时调用方回落追加式重发；无锚点的情况由调用方不传回调处理。
 */
export function shouldRegenerateFromRetry(params: {
  isLatestTurn: boolean
  sessionActive: boolean
}): boolean {
  return params.isLatestTurn && !params.sessionActive
}

/**
 * 从某条用户消息的位置向前解析回退锚点。
 *
 * - 之前还有主线 assistant 回复 → `rewind`（回退到该回复，截断其后全部对话）
 * - 没有（该用户消息就是会话第一条发言）→ `reset`（清空整段对话，回到会话起点）
 */
function resolveTargetBeforeUserIndex(
  messages: readonly SDKMessage[],
  userIndex: number,
  userMessage: string,
): RegenerateTarget {
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const record = messages[index] as unknown as SDKMessageRecord
    // 子代理（parent_tool_use_id 非空）消息没有独立回退点，只能落在主线 assistant 上。
    if (record.type !== 'assistant' || record.parent_tool_use_id) continue
    if (typeof record.uuid !== 'string' || record.uuid.length === 0) continue
    return { kind: 'rewind', userMessage, rewindToAssistantUuid: record.uuid }
  }

  // 首轮就失败：没有可保留的锚点，整段清空后重发
  return { kind: 'reset', userMessage }
}

/**
 * 解析「重新生成」的目标。
 *
 * - 最后一条用户消息之前还有主线 assistant 回复 → `rewind`（回退到该回复，截断最后一轮）
 * - 没有（首轮就失败）→ `reset`（清空整段对话，回到会话起点）
 *
 * 返回 undefined 仅当历史里没有任何用户输入消息（没有可重发的文本）。
 */
export function resolveRegenerateTarget(messages: readonly SDKMessage[]): RegenerateTarget | undefined {
  let lastUserIndex = -1
  let userMessage: string | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = getUserTextFromSDKMessage(messages[index]!)
    if (text !== null) {
      lastUserIndex = index
      userMessage = text
      break
    }
  }
  if (lastUserIndex < 0 || userMessage === null) return undefined

  return resolveTargetBeforeUserIndex(messages, lastUserIndex, userMessage)
}

/**
 * 解析「修改重发」的目标：锚点跟着**被修改的那条**用户消息走。
 *
 * 与「重新生成」的唯一区别是锚点来源——这里按 uuid 定位用户消息，再向前取主线 assistant，
 * 所以中间轮次被修改时，其后的对话同样会被截断（Agent 会话没有原地分支，只能回退重发）。
 *
 * 返回 undefined 的情形：
 * - 该 uuid 不在当前已加载的消息里（如历史窗口尚未加载到更早的部分）
 * - 该 uuid 指向的不是真实用户发言（tool_result / 子代理 / 合成消息 / Goal 迭代控制消息）
 */
export function resolveRewriteTarget(
  messages: readonly SDKMessage[],
  userMessageUuid: string,
): RegenerateTarget | undefined {
  if (!userMessageUuid) return undefined
  const userIndex = messages.findIndex((message) => getMessageUuid(message) === userMessageUuid)
  if (userIndex < 0) return undefined
  const userMessage = getUserTextFromSDKMessage(messages[userIndex]!)
  if (userMessage === null) return undefined

  return resolveTargetBeforeUserIndex(messages, userIndex, userMessage)
}

/** 「修改重发」提交被拦下的原因。 */
export type RewriteSubmitBlock =
  /** 会话不空闲（流式 / 后台任务 / 停止中 / 切内核中）：回退会被拒、或回退后发送被静默拦下 */
  | 'session-active'
  /** 锚点落在历史窗口边界：更早的消息尚未加载，此时「前面没有 assistant」不代表首轮 */
  | 'history-boundary'

/**
 * 「修改重发」提交前的安全判据（返回 undefined 表示可以提交）。
 *
 * 最重要的两条：
 * 1. **会话必须空闲**。回退本身要求会话不在运行（JSONL 并发写入会损坏文件），而就算回退先成功，
 *    紧接着的发消息也会被 `sendUserMessageInCurrentSession` 静默 return，留下
 *    「对话已截断但没重发」的中间态。所以必须在回退**之前**拦住。
 * 2. **历史窗口边界不能当首轮**。渲染层只持有窗口内的消息，若目标消息前面「没有 assistant」
 *    可能只是更早历史没加载；此时按 `reset` 回退会清空整段对话，是破坏性的误判。
 */
export function resolveRewriteSubmitBlock(params: {
  /** 会话是否处于非空闲态（流式 / 后台任务 / 停止中 / 切内核中）。 */
  sessionActive: boolean
  /** 已加载窗口之前是否还有更早的消息。 */
  hasEarlierHistory: boolean
  /** `resolveRewriteTarget` 的结果。 */
  target: RegenerateTarget
}): RewriteSubmitBlock | undefined {
  if (params.sessionActive) return 'session-active'
  if (params.target.kind === 'reset' && params.hasEarlierHistory) return 'history-boundary'
  return undefined
}
