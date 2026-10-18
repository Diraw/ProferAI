import type { AgentRuntimeCompletionSignal, AgentRunOutcome } from './events'

export interface AgentRunOutcomeReporter {
  onError(message: string): void
  onComplete(signal?: AgentRuntimeCompletionSignal): void
  rejectBeforeStart(): void
  finish(): AgentRunOutcome | undefined
}

/** 收敛 runtime 的错误、完成和停止信号，保证一次 run 最多产生一个终态。 */
export function createAgentRunOutcomeReporter(
  onOutcome?: (outcome: AgentRunOutcome) => void,
): AgentRunOutcomeReporter {
  let error: string | undefined
  let stopped = false
  let completionSeen = false
  let settled = false
  let outcome: AgentRunOutcome | undefined

  const report = (next: AgentRunOutcome): AgentRunOutcome => {
    outcome = next
    try {
      onOutcome?.(next)
    } catch {
      // 外部观察者不能改变 runtime 的终态。
    }
    return next
  }

  return {
    onError(message) {
      error ??= message || 'Agent 执行失败'
    },
    onComplete(signal) {
      if (signal?.backgroundTasksPending) return
      completionSeen = true
      if (signal?.stoppedByUser || signal?.endReason === 'stopped_by_user') stopped = true
      const errors = signal?.resultErrors?.filter((value) => value.trim()) ?? []
      const failedResult = signal?.resultSubtype !== undefined && signal.resultSubtype !== 'success'
      const malformedSuccess = signal?.resultSubtype === 'success' && errors.length > 0
      if ((failedResult || malformedSuccess) && !stopped) {
        error ??= errors.join('\n') || signal?.endReasonLabel || `Agent 运行未成功${signal?.resultSubtype ? ` (${signal.resultSubtype})` : ''}`
      }
      const nonCompletedReason = signal?.endReason !== undefined
        && signal.endReason !== 'completed'
        && signal.endReason !== 'stopped_by_user'
      if (nonCompletedReason && !stopped) error ??= signal?.endReasonLabel || `Agent 运行未成功 (${signal.endReason})`
    },
    rejectBeforeStart() {
      settled = true
    },
    finish() {
      if (settled) return outcome
      settled = true
      if (stopped) return report({ status: 'stopped' })
      if (error || !completionSeen) return report({ status: 'failed', error: error ?? 'Agent 未产生运行终态' })
      return report({ status: 'completed' })
    },
  }
}
