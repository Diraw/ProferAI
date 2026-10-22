import { isGoalResumableByMessage, normalizeGoalReason } from '@profer/shared'
import type { AgentGoalState } from '@profer/shared'

const GOAL_STATUS_LABELS: Record<AgentGoalState['status'], string> = {
  active: '执行中', stopping: '正在停止', paused: '已暂停', completed: '已完成',
  blocked: '等待处理', failed: '执行失败', stopped: '已停止', budget_limited: '预算已耗尽',
}

/** Goal 显示域只接收状态事实，不读取 atom、IPC 或组件。 */
export function isGoalRunning(goal: AgentGoalState | undefined): boolean {
  return (goal?.status === 'active' || goal?.status === 'stopping') && Boolean(goal.activeRunId)
}

export function formatGoalElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? `${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
}

export function getGoalElapsed(goal: AgentGoalState, now: number): number {
  return Math.max(0, goal.elapsedMs ?? 0) + (isGoalRunning(goal) ? Math.max(0, now - goal.updatedAt) : 0)
}

export function formatGoalBudget(limits: AgentGoalState['limits']): string {
  const parts = [
    limits.maxIterations === undefined ? '' : `${limits.maxIterations} 轮`,
    limits.maxDurationMs === undefined ? '' : formatGoalElapsed(limits.maxDurationMs),
    limits.maxTokens === undefined ? '' : `${limits.maxTokens.toLocaleString()} tokens`,
  ].filter(Boolean)
  return `${parts.length ? parts.join(' · ') : '不限'}（连续 ${limits.maxConsecutiveFailures} 轮无进展时停止）`
}

/** active 期间区分真实运行与等待；操作权限仍由 shared getGoalActions 决定。 */
export function getGoalStatusLabel(
  goal: AgentGoalState,
  waits: { askUser: number; permission: number },
  now: number,
): string {
  if (goal.status === 'active') {
    if (waits.askUser > 0) return '等待你的回答'
    if (waits.permission > 0) return '等待审批'
    if (goal.waiting === 'plan_mode') return '计划模式中，切换为可执行模式后自动继续'
    if (goal.retry && !goal.activeRunId) return `运行出错，${formatGoalElapsed(Math.max(0, goal.retry.nextAt - now))}后第 ${goal.retry.attempt} 次重试`
    return goal.activeRunId ? GOAL_STATUS_LABELS.active : '等待会话空闲'
  }
  if (isGoalResumableByMessage(goal)) return `${GOAL_STATUS_LABELS[goal.status]} · ${goal.status === 'blocked' ? '发消息补充后自动继续' : '发消息即可继续'}`
  if ((goal.reasonCode ?? normalizeGoalReason(goal.stopReason)) === 'app_restart') return `${GOAL_STATUS_LABELS[goal.status]} · 重启后待恢复`
  return GOAL_STATUS_LABELS[goal.status]
}
