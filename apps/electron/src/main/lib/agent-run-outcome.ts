import type { AgentSendInput } from '@profer/shared'

type RunOutcome = Parameters<NonNullable<AgentSendInput['onRunOutcome']>>[0]
type CompletionOptions = Parameters<NonNullable<import('./agent-orchestrator').SessionCallbacks['onComplete']>>[1]

/** 收敛运行回调的多个生命周期信号，保证 owner 最多收到一个终态。 */
export function createAgentRunOutcomeReporter(onOutcome?: (outcome: RunOutcome) => void) {
  let error: string | undefined
  let stopped = false
  let failedSubtype: string | undefined
  let completionSeen = false
  let settled = false

  return {
    onError(message: string) {
      error ??= message || 'Agent 执行失败'
    },
    onComplete(options?: CompletionOptions) {
      if (options?.backgroundTasksPending) return
      completionSeen = true
      if (options?.stoppedByUser) stopped = true
      if (options?.endReason === 'stopped_by_user') stopped = true
      const errors = options?.resultErrors?.filter(value => typeof value === 'string' && value.trim())
      const failed = options?.resultSubtype != null && options.resultSubtype !== 'success'
      const malformedSuccess = options?.resultSubtype === 'success' && (errors?.length ?? 0) > 0
      if ((failed || malformedSuccess) && !stopped) {
        failedSubtype = options?.resultSubtype
        error ??= errors?.join('\n') || (options?.endReasonLabel && options.endReasonLabel !== '' ? options.endReasonLabel : undefined)
          || `Agent 运行未成功${failedSubtype ? ` (${failedSubtype})` : ''}`
      }
      const nonCompletedReason = options?.endReason != null
        && options.endReason !== 'completed'
        && options.endReason !== 'stopped_by_user'
      if (nonCompletedReason && !stopped) {
        error ??= options?.endReasonLabel || `Agent 运行未成功 (${options?.endReason})`
      }
    },
    rejectBeforeStart() {
      settled = true
    },
    finish() {
      if (settled) return
      settled = true
      if (stopped) {
        try { onOutcome?.({ status: 'stopped' }) } catch { /* 外部观察者不能改变运行结果 */ }
      } else if (error || !completionSeen) {
        try { onOutcome?.({ status: 'failed', error: error ?? 'Agent 未产生运行终态' }) } catch { /* 外部观察者不能改变运行结果 */ }
      } else {
        try { onOutcome?.({ status: 'completed' }) } catch { /* 外部观察者不能改变运行结果 */ }
      }
    },
  }
}
