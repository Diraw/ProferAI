import type { ProcessLifecyclePort } from '@profer/agent-runtime'
import { BackgroundTaskManager } from './background-task-manager'

/** Electron 持有任务记录；SDK 停止由 adapter 回调执行。 */
export function createElectronClaudeProcessLifecyclePort(
  manager = new BackgroundTaskManager(),
): ProcessLifecyclePort {
  return {
    onSpawn() {},
    onTaskEvent(sessionId, event) {
      manager.upsert({ sessionId, taskId: event.taskId, ...(event.type ? { type: event.type } : {}), status: event.status, ...(event.summary ? { summary: event.summary } : {}), ...(event.outputFile ? { outputFile: event.outputFile } : {}) })
    },
    getTaskOutput: (sessionId, taskId, options) => manager.getOutput(sessionId, taskId, options),
    stopTask: async (sessionId, taskId, expectedType, providerStop) => {
      const record = manager.get(sessionId, taskId)
      if (!record) throw new Error(`后台任务不存在或不属于当前会话: ${taskId}`)
      if (expectedType && record.type && record.type !== expectedType) throw new Error(`后台任务类型不匹配: 期望 ${expectedType}，实际 ${record.type}`)
      if (record.status !== 'running') return
      if (!providerStop) throw new Error('Claude SDK task stop callback is not configured')
      await providerStop()
      // 等待 SDK 停止时可能收到 task_notification，不覆盖已完成/失败状态。
      if (manager.get(sessionId, taskId)?.status === 'running') manager.markStopped(sessionId, taskId)
    },
    onExit: sessionId => manager.forgetSession(sessionId),
  }
}
