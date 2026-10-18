import type { ProcessLifecyclePort } from '@profer/agent-runtime'

/**
 * Claude SDK 后台任务事件（task_started / task_progress / task_notification 归一化结果）。
 *
 * 原实现位于 packages/agent-runtime/src/claude/task-events.ts；按 provider 边界迁入本包，
 * 因为它是 Claude SDK 消息形状的适配，不属于 runtime 脊柱。
 */
export type ClaudeTaskEvent = Parameters<NonNullable<ProcessLifecyclePort['onTaskEvent']>>[1]

/** 归一化 SDK 后台任务事件，不读取宿主记录或输出文件。 */
export function normalizeClaudeTaskEvent(message: Readonly<Record<string, unknown>>): ClaudeTaskEvent | undefined {
  if (message.type !== 'system' || typeof message.task_id !== 'string' || !message.task_id) return undefined
  const taskId = message.task_id
  const rawType = message.task_type
  const type: 'agent' | 'shell' | undefined = rawType === 'shell' || rawType === 'bash' || rawType === 'local_bash' ? 'shell'
    : rawType === 'agent' || rawType === 'subagent' || rawType === 'task' ? 'agent' : undefined
  const common = { taskId, ...(type ? { type } : {}) }
  if (message.subtype === 'task_started') return { ...common, status: 'running' }
  const summary = typeof message.summary === 'string' ? message.summary : undefined
  if (message.subtype === 'task_progress') return { ...common, status: 'running', summary }
  if (message.subtype !== 'task_notification') return undefined
  const status = message.status === 'failed' || message.status === 'stopped' ? message.status : 'completed'
  const outputFile = typeof message.output_file === 'string' ? message.output_file : undefined
  return { ...common, status, summary, outputFile }
}
