import type { AgentSessionMeta } from '../types/agent'
import type { AgentRuntime } from '../types/agent-provider'

/** 请求未取得运行权，service 必须拒绝调用，不能向已有 owner 广播假终态。 */
export class AgentSessionRuntimeMismatchError extends Error {
  readonly code = 'AGENT_SESSION_RUNTIME_MISMATCH'
  constructor(expected: AgentRuntime, received: AgentRuntime) {
    super(`AGENT_SESSION_RUNTIME_MISMATCH: 会话固定使用 ${expected}，请求使用 ${received}；请新建对应内核的会话`)
    this.name = 'AgentSessionRuntimeMismatchError'
  }
}

/** 新会话首次运行前可选内核；旧正式会话缺省锁定，不迁移原生恢复资产。 */
export function canSelectAgentSessionRuntime(session: Partial<AgentSessionMeta> | undefined): boolean {
  if (!session || session.agentRuntimeLocked === true) return false
  if (session.agentRuntimeLocked !== false && session.draft !== true) return false
  return !(
    session.sdkSessionId || session.piSessionFile
    || Object.keys(session.piEntryBindings ?? {}).length
    || Object.keys(session.piFileCheckpoints ?? {}).length
    || session.forkSourceSdkSessionId || session.forkSourceDir || session.resumeAtMessageUuid
    || session.parentSessionId || session.explorationParentSessionId || session.sourceAutomationId
  )
}

/**
 * 同一 session 已有 run 持有执行权；本次请求未取得运行权。
 *
 * 它与 `AgentSessionRuntimeMismatchError` 同属「请求被拒绝」而不是 owner run 的
 * 流式错误或终态：调用方不得向该 session 广播 run_error / run_complete，也不得落盘。
 *
 * 定义在 shared（而非某个宿主）是因为新旧两条执行链都要抛它、宿主入口都要按
 * `instanceof` 识别它；字符串比较不能作为拒绝判据。
 */
export class AgentRunAlreadyActiveError extends Error {
  readonly code = 'AGENT_RUN_ALREADY_ACTIVE'

  constructor(readonly stopping: boolean) {
    super(`AGENT_RUN_ALREADY_ACTIVE: ${stopping ? 'Agent 正在停止，请稍候再试' : '上一条消息仍在处理中，请稍候再试'}`)
    this.name = 'AgentRunAlreadyActiveError'
  }
}

export const AGENT_SESSION_RUNTIME_LOCKED_MESSAGE = '此会话的 Agent 内核已固定；如需使用另一内核，请新建会话。'
