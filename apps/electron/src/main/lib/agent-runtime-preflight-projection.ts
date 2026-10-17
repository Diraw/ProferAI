/**
 * agent-runtime-preflight-projection — 凭证 / 环境 preflight 失败的用户可见投影
 *
 * 背景（来源：`parity/failures.md` G3、`05-next-slice.md` C1/C2）：
 * 同一入口切换后，用户在会话里看到的东西发生了变化 ——
 *
 * | | 旧路径（`AgentOrchestrator.sendMessage`） | 新路径（runtime coordinator） |
 * |---|---|---|
 * | 落盘 | `[['assistant'], ['system']]`：TypedError 气泡 + `interruption_record` | `[['user']]`：用户气泡 |
 * | 用户气泡 | **不落**（凭证失败发生在「步骤 5 持久化用户消息」之前） | 已落（coordinator 在凭证解析前同步落盘 `persistedUserMessage`） |
 * | 回调 | `onError(文案)` + `onComplete({startedAt, endReason:'error'})` | coordinator 级不调 `onError`，只有 `onComplete(failed)` |
 *
 * 本模块把**旧的用户可见语义**做成一个纯投影 + 一个宿主侧落盘执行器：
 * - `projectPreflightFailure`：给出「该落什么消息、该不该落用户气泡、onError 文案、终态字段」；
 * - `applyPreflightFailureProjection`：按旧顺序把 transcript 写进 `SessionPort` 并写 `lastInterrupt*` meta。
 *
 * 边界与责任：
 * - 产品语义（错误气泡 / interruption_record / 中断 chip）留在**宿主**，不下沉到 runtime core。
 * - TypedError 的文案表仍由宿主提供（旧实现在 `agent-orchestrator.ts` 内联），
 *   本模块**不复制**产品文案，只接收已解析的 `TypedError`。
 * - 用户气泡的抑制需要「先解析凭证、成功后才落用户消息」的顺序保证；
 *   该顺序在 runtime core 的 `persistedUserMessage` 落盘时机上，本模块不自行修改 coordinator，
 *   已作为明确顺序要求写入 `integration-requests.md`（IR-2）。
 */

import type { SessionPort } from '@profer/agent-runtime'
import type { SDKMessage, TypedError } from '@profer/shared'
import { normalizeAgentEndReason } from './agent-end-reason'
import type { RuntimeTerminalFields } from './agent-runtime-terminal-projection'

/** preflight 失败投影：宿主据此落盘 + 回调，不自行挑选字段。 */
export interface PreflightFailureProjection {
  kind: 'preflight_failure'
  /** 旧顺序的 transcript：TypedError 助手气泡 → `interruption_record` 系统消息。 */
  transcript: SDKMessage[]
  /** 旧路径凭证失败不落用户消息；宿主必须在落盘前抑制 `persistedUserMessage`。 */
  suppressUserMessage: true
  /** `onError` 文案，等于 TypedError 气泡正文（`标题: 消息`）。 */
  errorText: string
  /** `onComplete` 字段，与旧 owner-finally 归一化同源。 */
  fields: RuntimeTerminalFields
  /** 与 `interruption_record` 同一时间戳的 meta 补丁（旧路径写入 `lastInterrupt*`）。 */
  interruptMeta: { lastInterruptReason: string; lastInterruptLabel: string; lastInterruptAt: number }
}

export interface ProjectPreflightFailureInput {
  typedError: TypedError
  /** 本轮 run 起始时刻（旧路径 `opts.startedAt = input.startedAt`）。 */
  startedAt?: number
  /** 时间戳注入，便于测试；缺省 `Date.now()`。 */
  now?: () => number
}

/** TypedError 正文：旧实现为 `标题: 消息`（无标题时只用消息）。 */
export function formatTypedErrorText(typedError: Pick<TypedError, 'title' | 'message'>): string {
  return typedError.title ? `${typedError.title}: ${typedError.message}` : typedError.message
}

/**
 * 把 preflight 失败投影成旧路径的用户可见结果。
 *
 * `endReason` / `endReasonLabel` 复用 `normalizeAgentEndReason({ hasError: true })`：
 * 旧路径此时 `resultSubtype` 为空、`hasError === true`，归一化结果为 `error` / 「执行出错」。
 * 不在这里新写「执行出错」字符串，避免与 `AGENT_END_REASON_LABELS` 漂移。
 */
export function projectPreflightFailure(input: ProjectPreflightFailureInput): PreflightFailureProjection {
  const now = input.now ?? Date.now
  const createdAt = now()
  const errorText = formatTypedErrorText(input.typedError)
  const { reason, label } = normalizeAgentEndReason({ hasError: true })

  const errorSDKMsg = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: errorText }] },
    parent_tool_use_id: null,
    error: { message: input.typedError.message, errorType: input.typedError.code },
    _createdAt: createdAt,
    _errorCode: input.typedError.code,
    _errorTitle: input.typedError.title,
    _errorDetails: input.typedError.details,
    _errorCanRetry: input.typedError.canRetry,
    _errorActions: input.typedError.actions,
  } as unknown as SDKMessage

  const interruptionRecord = {
    type: 'system',
    subtype: 'interruption_record',
    message: label,
    _createdAt: createdAt,
  } as unknown as SDKMessage

  return {
    kind: 'preflight_failure',
    transcript: [errorSDKMsg, interruptionRecord],
    suppressUserMessage: true,
    errorText,
    fields: {
      stoppedByUser: false,
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      endReason: reason,
      endReasonLabel: label,
    },
    interruptMeta: {
      lastInterruptReason: reason,
      lastInterruptLabel: label,
      lastInterruptAt: createdAt,
    },
  }
}

export interface ApplyPreflightFailureResult {
  /** 是否成功写入 transcript。 */
  appended: boolean
  /** 是否成功写入 `lastInterrupt*` meta。 */
  metaUpdated: boolean
  errors: string[]
}

/**
 * 宿主侧落盘执行器：按旧顺序把 preflight transcript 写入会话，并写 `lastInterrupt*`。
 *
 * 与旧实现一致：落盘失败**不**阻断错误回调（旧代码 `try/catch` + `console.error`），
 * 但这里把错误收集进返回值，避免静默吞掉（旧实现的 console.error 无法被测试断言）。
 *
 * 落盘粒度也照抄旧路径：错误气泡与 `interruption_record` 是**两次** `appendMessages`
 * （旧实现分别在 `reportPreflightError` 与 owner-finally 中落盘），而不是一次批量写入。
 * parity 断言直接比较 `appendCalls` 的批次结构，批次粒度是用户可见顺序的一部分。
 *
 * `updateMeta` 的 patch 类型用 `Partial<AgentSessionMeta>` 交叉断言，
 * 因为 `lastInterrupt*` 字段在 shared 类型里是可选成员而非索引签名。
 */
export function applyPreflightFailureProjection(input: {
  sessions: Pick<SessionPort, 'appendMessages' | 'updateMeta'>
  sessionId: string
  projection: PreflightFailureProjection
}): ApplyPreflightFailureResult {
  const errors: string[] = []
  let appended = false
  let metaUpdated = false

  for (const message of input.projection.transcript) {
    try {
      input.sessions.appendMessages(input.sessionId, [message])
      appended = true
    } catch (error) {
      errors.push(`appendMessages: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    input.sessions.updateMeta(input.sessionId, input.projection.interruptMeta as never)
    metaUpdated = true
  } catch (error) {
    errors.push(`updateMeta: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { appended, metaUpdated, errors }
}

/**
 * preflight 失败是否必须在 provider 启动前判定。
 *
 * 旧路径把凭证解析放在「持久化用户消息」之前，因此凭证失败天然不产生孤儿用户气泡。
 * 新路径当前顺序相反，宿主入口需要显式抑制 `persistedUserMessage`（见 IR-2）。
 * 该函数只表达「必须抑制」这一事实，供宿主入口断言/接线使用。
 */
export function requiresUserMessageSuppression(kind: PreflightFailureProjection['kind']): boolean {
  return kind === 'preflight_failure'
}
