import { describe, expect, test } from 'bun:test'
import { normalizeGoalToolResult } from './goal-tools'

describe('goal tools', () => {
  test('normalizes structured tool results', () => {
    expect(normalizeGoalToolResult({
      status: 'complete',
      summary: '已完成',
      evidence: ['测试通过', 42, '  产物已生成  '],
    })).toMatchObject({ status: 'complete', summary: '已完成', evidence: ['测试通过', '产物已生成'], outcome: 'success' })
  })

  test('filters whitespace evidence and rejects evidence-less complete', () => {
    expect(normalizeGoalToolResult({ status: 'continue', summary: '执行了检查', evidence: ['', '  ', ' 测试通过 '] })).toMatchObject({ status: 'continue', summary: '执行了检查', evidence: ['测试通过'], outcome: 'success' })
    expect(normalizeGoalToolResult({ status: 'complete', summary: '完成', evidence: ['', ' '] })).toMatchObject({ outcome: 'failed', evidence: [] })
    expect(normalizeGoalToolResult({ status: 'continue', summary: ' ', evidence: ['证据'] })).toMatchObject({ outcome: 'failed' })
  })

  test('invalid reports fail instead of impersonating successful continue', () => {
    expect(normalizeGoalToolResult({ status: 'invalid', summary: 42, evidence: 'not-array' })).toEqual({
      status: 'continue',
      summary: '',
      evidence: [],
      outcome: 'failed',
      error: 'Goal 报告格式无效或缺少真实证据',
    })
  })
})
