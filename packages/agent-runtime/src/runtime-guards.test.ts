import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeGuardMessage } from './runtime-guards'
import { appendOutputFormatInstruction, createAgentRuntimeGuard } from './runtime-guards'

/** 核心测试只使用本地结构 fixture，不依赖任何 provider SDK 的消息类型。 */
interface GuardFixtureMessage extends AgentRuntimeGuardMessage {
  role: 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string }>
  usage: { cost: { total: number } }
}

function assistant(text: string, cost = 0): GuardFixtureMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], usage: { cost: { total: cost } } }
}

describe('Agent runtime limits and output validation', () => {
  test('Given a turn limit When assistant turns reach it Then later tools terminate and the result preserves the limit reason', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 2 })
    guard.recordMessage({ role: 'user', content: 'fixture' })
    guard.recordMessage(assistant('first'))
    expect(guard.shouldStopBeforeNextTurn()).toBe(false)
    guard.recordMessage(assistant('second'))
    expect(guard.shouldStopBeforeNextTurn()).toBe(true)
    expect(guard.applyToolResult({ content: [{ type: 'text', text: 'result' }], details: {} }).terminate).toBe(true)
    // 覆盖层交给 provider 转换：这里只锁定核心自己承诺的 override 契约。
    expect(guard.getLimitResultOverride()).toMatchObject({ subtype: 'error_max_turns', terminalReason: 'max_turns' })
  })

  test('Given budget and turn limits When both are reached Then budget wins and the stop reason stays fixed', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 1, maxBudgetUsd: 0.5 })
    guard.recordMessage(assistant('paid response', 0.5))
    expect(guard.getLimitResultOverride()).toMatchObject({ subtype: 'error_max_budget_usd', terminalReason: 'max_budget_usd' })
    guard.recordMessage(assistant('later response'))
    expect(guard.getLimitResultOverride()?.terminalReason).toBe('max_budget_usd')
  })

  test('Given invalid limits and unknown cost When recording messages Then tools keep their original result', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: Number.NaN, maxBudgetUsd: -1 })
    guard.recordMessage(assistant('unknown cost', Number.NaN))
    const result = { content: [{ type: 'text' as const, text: 'fixture' }], details: {} }
    expect(guard.applyToolResult(result)).toBe(result)
    expect(guard.shouldStopBeforeNextTurn()).toBe(false)
  })

  test('Given structured output When validating the final response Then valid fenced JSON passes and missing or extra fields fail', () => {
    const guard = createAgentRuntimeGuard({ outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false } } })
    expect(guard.getResultOverride([assistant('```json\n{"count":2}\n```')])).toBeUndefined()
    const failure = guard.getResultOverride([assistant('{"extra":true}')])
    expect(failure).toMatchObject({ subtype: 'error_during_execution', terminalReason: 'output_validation_failed' })
    expect(failure?.errors).toContain('$.count: 缺少必填字段')
    expect(failure?.errors).toContain('$.extra: 不允许的额外字段')
    expect(guard.getResultOverride([assistant('invalid json')])?.errors[0]).toContain('不是有效 JSON')
  })

  test('Given output constraints and a reached run limit When completing Then the limit takes precedence over schema validation', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 1, outputFormat: { type: 'json_schema', schema: { type: 'object' } } })
    guard.recordMessage(assistant('not JSON'))
    expect(guard.getResultOverride([assistant('not JSON')])?.terminalReason).toBe('max_turns')
    expect(appendOutputFormatInstruction('prompt', { type: 'json_schema', name: 'result', schema: { type: 'object' } })).toContain('<output_format>')
    expect(appendOutputFormatInstruction('prompt')).toBe('prompt')
  })
})
