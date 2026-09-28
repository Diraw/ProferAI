import { parseGoalCommand as parseGoalCommandShared } from '@profer/shared'
import type { AgentGoalContract, AgentGoalIterationResult, AgentGoalState, AgentGoalLimits, AgentGoalCommand, AgentGoalContinuation } from '@profer/shared'

export const DEFAULT_GOAL_LIMITS: AgentGoalLimits = {
  maxIterations: 20,
  maxConsecutiveFailures: 3,
  maxDurationMs: 2 * 60 * 60 * 1000,
}

/** Goal 迭代历史保留上限，防止长期运行的 Goal 状态无限膨胀 */
export const GOAL_HISTORY_LIMIT = 20

/** 兼容既有 import；唯一实现已收敛到 @profer/shared（renderer 与 main 共用）。 */
export function parseGoalCommand(input: string): AgentGoalCommand {
  return parseGoalCommandShared(input)
}

/**
 * 组装 Goal 单轮迭代 prompt（Codex 式 plan→act→verify→review 循环）。
 * 注入目标契约与剩余预算，让 Agent 在明确的验收标准与边界内工作。
 */
export function buildGoalIterationPrompt(
  state: Pick<AgentGoalState, 'goal' | 'contract' | 'iteration' | 'limits' | 'startedAt' | 'history'>,
  input: { previousSummary?: string; now?: number },
): string {
  const now = input.now ?? Date.now()
  // 调用方（GoalController）在进入本轮前已把 state.iteration 自增到当前轮次
  const iteration = state.iteration
  const remainingIterations = Math.max(0, state.limits.maxIterations - iteration)
  const remainingMinutes = Math.max(0, Math.round((state.limits.maxDurationMs - (now - state.startedAt)) / 60000))
  const displayIteration = Math.max(1, iteration)
  const lines = [
    `你正在持续执行一个 Goal（长时自主任务）。目标：${state.goal}`,
  ]
  if (state.contract?.verification) lines.push(`验收标准（verify）：${state.contract.verification}`)
  if (state.contract?.constraints) lines.push(`约束（constraint）：${state.contract.constraints}`)
  if (state.contract?.stopWhen) lines.push(`停止条件（stop）：${state.contract.stopWhen}`)
  lines.push(`这是第 ${displayIteration} 轮。剩余预算：约 ${remainingIterations} 轮 / ${remainingMinutes} 分钟，预算耗尽前务必收敛到 complete 或 blocked。`)
  if (input.previousSummary) lines.push(`上一轮摘要：${input.previousSummary}`)
  const recentHistory = (state.history ?? []).slice(-3)
  if (recentHistory.length > 0) {
    lines.push('近期迭代轨迹：')
    for (const record of recentHistory) {
      lines.push(`- 第 ${record.iteration} 轮（${record.status}）：${record.summary.slice(0, 200)}`)
    }
  }
  lines.push(
    [
      '工作方式：先规划本轮动作，再实际执行（不要只给建议），然后验证结果并复盘。多步任务请用任务图拆解并与 Goal 对齐。',
      state.contract?.verification
        ? '完成判定：只有当验收标准被真实证据满足时才允许 complete。'
        : '完成判定：本轮请先为这个目标拟定可验证的验收标准并写入 summary，后续轮次以证据满足它为准。',
      '每轮结束时必须调用 update_goal 报告结构化结果（status=continue|complete|blocked、summary、evidence）。这是内部控制通道，不要在普通回复中输出 XML/JSON 协议。只有目标真正完成且 evidence 非空时才使用 complete；遇到需要你介入的阻塞时使用 blocked 并在 summary 说明需要什么。若 update_goal 不可用，再使用兼容格式 <goal_result>{"status":"continue|complete|blocked","summary":"...","evidence":["..."]}</goal_result>。',
    ].join('\n'),
  )
  return lines.join('\n')
}

export function createGoalState(sessionId: string, goal: string, now = Date.now(), limits = DEFAULT_GOAL_LIMITS, contract?: AgentGoalContract): AgentGoalState {
  return {
    id: crypto.randomUUID(),
    sessionId,
    goal: goal.trim(),
    status: 'active',
    iteration: 0,
    consecutiveFailures: 0,
    startedAt: now,
    updatedAt: now,
    limits,
    contract,
    history: [],
  }
}

export function evaluateGoalContinuation(
  result: AgentGoalIterationResult,
  context: { iteration: number; consecutiveFailures: number; startedAt: number; now: number; limits: AgentGoalLimits; turnFailed?: boolean },
): AgentGoalContinuation {
  const failures = context.turnFailed ? context.consecutiveFailures + 1 : 0
  if (context.now - context.startedAt >= context.limits.maxDurationMs) return { action: 'limit_reached', consecutiveFailures: failures, reason: '已达到 Goal 最大运行时长' }
  if (context.iteration >= context.limits.maxIterations) return { action: 'limit_reached', consecutiveFailures: failures, reason: '已达到 Goal 最大迭代轮次' }
  if (failures >= context.limits.maxConsecutiveFailures) return { action: 'failed', consecutiveFailures: failures, reason: '连续执行失败次数达到上限' }
  if (result.status === 'complete' && result.evidence.length > 0) return { action: 'complete', consecutiveFailures: 0 }
  if (result.status === 'blocked') return { action: 'blocked', consecutiveFailures: failures, reason: result.summary }
  return { action: 'continue', consecutiveFailures: failures }
}

export function parseGoalIterationResult(text: string): AgentGoalIterationResult {
  // 会话里同时存在控制 prompt 中的协议示例（status 值为 "continue|complete|blocked"）
  // 和本轮真实输出；从尾部向前找第一个解析成功且 status 合法的块。
  const matches = [...text.matchAll(/<goal_result>\s*([\s\S]*?)\s*<\/goal_result>/gi)]
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i]![1] ?? '') as Partial<AgentGoalIterationResult>
      if (parsed.status !== 'continue' && parsed.status !== 'complete' && parsed.status !== 'blocked') continue
      return {
        status: parsed.status,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((item): item is string => typeof item === 'string') : [],
      }
    } catch {
      continue
    }
  }
  if (matches.length > 0) {
    return { status: 'continue', summary: 'Goal 结果协议解析失败，继续执行并要求下一轮重新汇报。', evidence: [] }
  }
  return { status: 'continue', summary: text.slice(-2000), evidence: [] }
}

export function stopGoalForProcessExit(goal: AgentGoalState, now = Date.now()): AgentGoalState {
  return { ...goal, status: 'stopped', stopReason: 'process_exit', updatedAt: now }
}

/**
 * 应用进程退出时的 Goal 语义（Codex 式持久目标）：不判死刑，
 * 降级为 paused 并标记 app_restart，重启后用户可显式 resume。
 */
export function pauseGoalForProcessExit(goal: AgentGoalState, now = Date.now()): AgentGoalState {
  return { ...goal, status: 'paused', stopReason: 'app_restart', updatedAt: now }
}
