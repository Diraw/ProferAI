import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentGoalState } from '@profer/shared'
import { GOAL_HISTORY_LIMIT } from './goal-loop'

/**
 * Goal 状态持久化（userData/goals.json）。
 * Codex 的 goal 是「跨 turn 的持久目标」；Profer 按其语义把 Goal 做成可跨重启恢复的状态，
 * 进程退出时标记 paused 而非丢弃。
 */

function sanitize(state: AgentGoalState): AgentGoalState {
  const history = Array.isArray(state.history) ? state.history.slice(-GOAL_HISTORY_LIMIT) : []
  return { ...state, history }
}

export function loadGoalStates(filePath: string): AgentGoalState[] {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    const list = Array.isArray((parsed as { goals?: unknown }).goals) ? (parsed as { goals: unknown[] }).goals : []
    return list.filter((item): item is AgentGoalState => {
      const state = item as AgentGoalState
      return Boolean(state && typeof state === 'object' && typeof state.sessionId === 'string' && typeof state.goal === 'string' && typeof state.status === 'string')
    }).map(sanitize)
  } catch {
    return []
  }
}

export function saveGoalStates(filePath: string, states: AgentGoalState[]): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const payload = JSON.stringify({ version: 1, goals: states.map(sanitize) }, null, 2)
  const tempPath = `${filePath}.tmp`
  writeFileSync(tempPath, payload, 'utf8')
  renameSync(tempPath, filePath)
}
