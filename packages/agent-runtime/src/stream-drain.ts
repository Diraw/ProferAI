export type AgentStreamDrainState = 'open' | 'result_received' | 'closed' | 'stopped'
export type AgentStreamDrainSignal = 'result' | 'iterator_done' | 'stop'

/** result 只表示 runtime 有结果，iterator_done 才表示流可以进入最终收尾。 */
export function advanceAgentStreamDrain(
  state: AgentStreamDrainState,
  signal: AgentStreamDrainSignal,
): AgentStreamDrainState {
  if (state === 'closed' || state === 'stopped') return state
  if (signal === 'stop') return 'stopped'
  if (signal === 'iterator_done') return 'closed'
  return 'result_received'
}

export function shouldWaitForAgentStreamDrain(state: AgentStreamDrainState): boolean {
  return state === 'result_received'
}
