import type { ProcessLifecyclePort } from '@profer/agent-runtime'
import { BackgroundTaskManager } from '../src/background-task-manager'

/**
 * 非 Electron 验证 fixture：Claude 后台任务宿主端口替身。
 *
 * 语义与 Electron 的 createElectronClaudeProcessLifecyclePort 一致（宿主持有任务记录、
 * SDK 停止由 provider 回调执行），用于证明 provider 只依赖 ProcessLifecyclePort 契约，
 * 不依赖任何 Electron 实现。
 */
export function createFakeClaudeLifecyclePort(
  manager = new BackgroundTaskManager(),
): { port: ProcessLifecyclePort; manager: BackgroundTaskManager; spawns: Array<{ sessionId: string; pid: number }>; exits: string[] } {
  const spawns: Array<{ sessionId: string; pid: number }> = []
  const exits: string[] = []
  const port: ProcessLifecyclePort = {
    onSpawn(sessionId, pid) {
      spawns.push({ sessionId, pid })
    },
    onTaskEvent(sessionId, event) {
      manager.upsert({
        sessionId,
        taskId: event.taskId,
        ...(event.type ? { type: event.type } : {}),
        status: event.status,
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.outputFile ? { outputFile: event.outputFile } : {}),
      })
    },
    getTaskOutput: (sessionId, taskId, options) => manager.getOutput(sessionId, taskId, options),
    stopTask: async (sessionId, taskId, expectedType, providerStop) => {
      const record = manager.get(sessionId, taskId)
      if (!record) throw new Error(`后台任务不存在或不属于当前会话: ${taskId}`)
      if (expectedType && record.type && record.type !== expectedType) throw new Error(`后台任务类型不匹配: 期望 ${expectedType}，实际 ${record.type}`)
      if (record.status !== 'running') return
      if (!providerStop) throw new Error('Claude SDK task stop callback is not configured')
      await providerStop()
      if (manager.get(sessionId, taskId)?.status === 'running') manager.markStopped(sessionId, taskId)
    },
    onExit(sessionId) {
      exits.push(sessionId)
      manager.forgetSession(sessionId)
    },
  }
  return { port, manager, spawns, exits }
}
