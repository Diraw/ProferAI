import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGoalStates, saveGoalStates } from './goal-store'
import { createGoalState, DEFAULT_GOAL_LIMITS } from './goal-loop'

describe('goal store', () => {
  test('round-trips goal states', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = createGoalState('session-1', '完成登录页', 1000, DEFAULT_GOAL_LIMITS, { verification: '测试通过' })
      saveGoalStates(file, [{ ...goal, status: 'paused' }])
      const loaded = loadGoalStates(file)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toMatchObject({ sessionId: 'session-1', goal: '完成登录页', status: 'paused', contract: { verification: '测试通过' }, history: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns empty list for missing or corrupt files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      expect(loadGoalStates(join(dir, 'missing.json'))).toEqual([])
      const corrupt = join(dir, 'corrupt.json')
      writeFileSync(corrupt, '{not json', 'utf8')
      expect(loadGoalStates(corrupt)).toEqual([])
      const invalid = join(dir, 'invalid.json')
      writeFileSync(invalid, JSON.stringify({ goals: [{ foo: 1 }] }), 'utf8')
      expect(loadGoalStates(invalid)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('caps persisted history to the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'))
    try {
      const file = join(dir, 'goals.json')
      const goal = createGoalState('session-1', '长跑', 1000)
      const history = Array.from({ length: 40 }, (_, index) => ({
        iteration: index + 1,
        startedAt: 1000 + index,
        finishedAt: 1001 + index,
        status: 'continue' as const,
        summary: `第 ${index + 1} 轮`,
        evidence: [],
      }))
      saveGoalStates(file, [{ ...goal, history }])
      const loaded = loadGoalStates(file)
      expect(loaded[0]?.history).toHaveLength(20)
      expect(loaded[0]?.history?.[19]?.iteration).toBe(40)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
