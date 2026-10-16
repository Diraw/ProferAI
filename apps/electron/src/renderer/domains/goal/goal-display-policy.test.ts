import { describe, expect, test } from 'bun:test'
import type { AgentGoalState } from '@profer/shared'
import { formatGoalBudget, formatGoalElapsed, getGoalElapsed, getGoalStatusLabel, isGoalRunning } from './goal-display-policy'

const goal = (patch: Partial<AgentGoalState> = {}): AgentGoalState => ({
  id: 'goal', sessionId: 'session', goal: '目标', status: 'active', revision: 1, iteration: 2,
  consecutiveFailures: 0, startedAt: 100, updatedAt: 1_000, elapsedMs: 4_000,
  limits: { maxConsecutiveFailures: 3 }, ...patch,
})

describe('Goal 显示 domain', () => {
  test('只有明确 owner 的 active/stopping 才计入实时运行时长', () => {
    expect(isGoalRunning(goal())).toBe(false)
    expect(isGoalRunning(goal({ activeRunId: 'run' }))).toBe(true)
    expect(isGoalRunning(goal({ status: 'stopping', activeRunId: 'run' }))).toBe(true)
    expect(isGoalRunning(goal({ status: 'paused', activeRunId: 'run' }))).toBe(false)
    expect(getGoalElapsed(goal({ activeRunId: 'run' }), 2_500)).toBe(5_500)
  })

  test('状态文案区分审批、计划、重试和可发消息续跑', () => {
    expect(getGoalStatusLabel(goal({ activeRunId: 'run' }), { askUser: 1, permission: 0 }, 2_000)).toBe('等待你的回答')
    expect(getGoalStatusLabel(goal({ waiting: 'plan_mode' }), { askUser: 0, permission: 0 }, 2_000)).toContain('计划模式')
    expect(getGoalStatusLabel(goal({ retry: { attempt: 2, nextAt: 3_000, error: '网络' } }), { askUser: 0, permission: 0 }, 2_000)).toContain('第 2 次重试')
    expect(getGoalStatusLabel(goal({ status: 'blocked' }), { askUser: 0, permission: 0 }, 2_000)).toContain('发消息补充后自动继续')
  })

  test('预算和时长格式保持稳定且不受组件依赖', () => {
    expect(formatGoalElapsed(65_000)).toBe('1m5s')
    expect(formatGoalBudget({ maxIterations: 3, maxDurationMs: 120_000, maxConsecutiveFailures: 2 })).toContain('3 轮 · 2m')
    expect(formatGoalBudget({ maxConsecutiveFailures: 2 })).toContain('不限')
  })
})
