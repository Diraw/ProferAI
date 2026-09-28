import { describe, expect, test } from 'bun:test'
import { normalizeGoalToolResult } from './goal-tools'

describe('goal tools', () => {
  test('normalizes structured tool results', () => {
    expect(normalizeGoalToolResult({
      status: 'complete',
      summary: '已完成',
      evidence: ['测试通过', 42, '  产物已生成  '],
    })).toEqual({ status: 'complete', summary: '已完成', evidence: ['测试通过', '产物已生成'] })
  })

  test('falls back to continue for invalid status and evidence', () => {
    expect(normalizeGoalToolResult({ status: 'invalid', summary: 42, evidence: 'not-array' })).toEqual({
      status: 'continue',
      summary: '',
      evidence: [],
    })
  })
})
