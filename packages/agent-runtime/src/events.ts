import type { AgentEvent, AgentStreamPayload, ProferEvent, SDKMessage } from '@profer/shared'

export type AgentRunOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: string }
  | { status: 'stopped' }

export type AgentRuntimeEvent =
  | { type: 'message'; message: SDKMessage }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'host_event'; sessionId: string; event: ProferEvent }
  | { type: 'stream_payload'; sessionId: string; payload: AgentStreamPayload }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  /**
   * 执行权已被本轮 run 取得（claim / active）：不等于 provider 已经启动。
   *
   * 与 `runtime_started` 的分工（凭证 / 资源 / 工具装配准备阶段可能失败，provider 从未参与）：
   * - `runtime_claimed`：只表示「本宿主上这个会话有一轮 run 在跑」，宿主据此维护运行态快照
   *   （`isRuntimeRunActive`）与 owner 可见性；**不得**触发未读清除 / draft 晋升 /
   *   `external_run_started` 等「真正运行开始」的副作用。
   * - `runtime_started`：准备成功、provider 即将启动时才发出，是上述副作用的唯一触发点。
   */
  | { type: 'runtime_claimed'; sessionId: string; runtime: string; startedAt: number; title?: string; workspaceId?: string; modelId?: string; initiator?: import('@profer/shared').AgentRunInitiator }
  | { type: 'runtime_started'; sessionId: string; runtime: string; startedAt: number; title?: string; workspaceId?: string; modelId?: string; initiator?: import('@profer/shared').AgentRunInitiator }
  | { type: 'runtime_finished'; sessionId: string; runtime?: string; outcome: AgentRunOutcome; finishedAt: number; title?: string; workspaceId?: string; modelId?: string; initiator?: import('@profer/shared').AgentRunInitiator }

export interface AgentRuntimeCompletionSignal {
  stoppedByUser?: boolean
  endReason?: string
  endReasonLabel?: string
  resultSubtype?: string
  resultErrors?: readonly string[]
  backgroundTasksPending?: boolean
}
