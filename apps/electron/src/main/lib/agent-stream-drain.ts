/**
 * Agent stream drain 生命周期。
 *
 * result 只是 runtime 报告了一轮结果，不代表外层 async iterator 已经关闭。
 * 只有 iterator_done 才允许 owner 进入最终收尾；stop 仍可主动打断等待中的 iterator。
 */
export type AgentStreamDrainState = 'open' | 'result_received' | 'closed' | 'stopped'
export type AgentStreamDrainSignal = 'result' | 'iterator_done' | 'stop'

export function advanceAgentStreamDrain(
  state: AgentStreamDrainState,
  signal: AgentStreamDrainSignal,
): AgentStreamDrainState {
  if (state === 'closed' || state === 'stopped') return state
  if (signal === 'stop') return 'stopped'
  if (signal === 'iterator_done') return 'closed'
  return 'result_received'
}

/** result 到达后仍未收到 iterator done 时，必须继续等待而不是强制关闭。 */
export function shouldWaitForAgentStreamDrain(state: AgentStreamDrainState): boolean {
  return state === 'result_received'
}
