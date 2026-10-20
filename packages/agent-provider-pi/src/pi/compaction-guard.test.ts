import { describe, expect, test } from 'bun:test'
import {
  PI_COMPACTION_SKIPPED_SUBTYPE,
  PiManualCompactionGuard,
  countPiEffectiveTurns,
  createPiCompactionSkippedMessage,
} from './compaction-guard'

const CONTINUATION_PROMPT = '<profer_compaction_continuation>\n继续完成原始任务。\n</profer_compaction_continuation>'

function userMessage(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistantMessage(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

describe('countPiEffectiveTurns', () => {
  test('只数含内容的 user 消息，忽略 assistant / toolResult', () => {
    const messages = [
      userMessage('看下这个 bug'),
      assistantMessage('好的'),
      { role: 'toolResult', content: [{ type: 'text', text: '输出' }] },
      userMessage('继续'),
    ]
    expect(countPiEffectiveTurns(messages)).toBe(2)
  })

  test('空文本的 user 消息不算一轮', () => {
    expect(countPiEffectiveTurns([userMessage('   '), userMessage('')])).toBe(0)
  })

  test('只有图片的 user 消息算一轮', () => {
    expect(countPiEffectiveTurns([{ role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }])).toBe(1)
  })

  test('排除 Profer 注入的压缩续跑提示', () => {
    const messages = [userMessage('原始任务'), userMessage(CONTINUATION_PROMPT), userMessage(CONTINUATION_PROMPT)]
    expect(countPiEffectiveTurns(messages, { ignoreTextPrefixes: [CONTINUATION_PROMPT] })).toBe(1)
  })

  test('坏数据不抛错', () => {
    expect(countPiEffectiveTurns([null, undefined, 42, { role: 'user' }])).toBe(0)
  })
})

describe('PiManualCompactionGuard', () => {
  test('轮次足够且无历史时放行', () => {
    const guard = new PiManualCompactionGuard()
    expect(guard.evaluate('s1', 2)).toEqual({ allowed: true })
  })

  test('有效轮次不足 2 时跳过，并给出轮次数', () => {
    const guard = new PiManualCompactionGuard()
    const decision = guard.evaluate('s1', 1)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('too_few_turns')
    expect(decision.message).toContain('1 轮')
  })

  test('压缩未返回时再次请求被跳过', () => {
    const guard = new PiManualCompactionGuard()
    expect(guard.evaluate('s1', 5)).toEqual({ allowed: true })
    guard.begin('s1')
    // in-flight 优先于轮次判断：这次请求根本不该走到 session.compact()。
    expect(guard.evaluate('s1', 1).reason).toBe('in_flight')
    guard.settle('s1', 'compacted')
    expect(guard.evaluate('s1', 5)).toEqual({ allowed: true })
  })

  test('noop / 失败不计入熔断，只有真正压缩成功才计数', () => {
    const guard = new PiManualCompactionGuard()
    guard.begin('s1')
    guard.settle('s1', 'noop')
    guard.begin('s1')
    guard.settle('s1', 'failed')
    expect(guard.inspect('s1')?.recentCompactions).toBe(0)
    expect(guard.evaluate('s1', 3)).toEqual({ allowed: true })
  })

  test('窗口内连续压缩两次后熔断，窗口过期后恢复', () => {
    let now = 1_000_000
    const guard = new PiManualCompactionGuard({ circuitWindowMs: 5 * 60_000, circuitMaxCompactions: 2, now: () => now })
    for (let index = 0; index < 2; index += 1) {
      expect(guard.evaluate('s1', 4)).toEqual({ allowed: true })
      guard.begin('s1')
      guard.settle('s1', 'compacted')
      now += 30_000
    }
    const blocked = guard.evaluate('s1', 4)
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('circuit_open')
    expect(blocked.message).toContain('2 次')

    // 窗口滑过第一次压缩后只剩 1 次，重新放行。
    now += 5 * 60_000
    expect(guard.evaluate('s1', 4)).toEqual({ allowed: true })
  })

  test('会话状态按 sessionId 隔离', () => {
    const guard = new PiManualCompactionGuard()
    guard.begin('s1')
    expect(guard.evaluate('s2', 4)).toEqual({ allowed: true })
    expect(guard.evaluate('s1', 4).reason).toBe('in_flight')
  })

  test('长期运行不会无限累积会话状态', () => {
    let now = 0
    const guard = new PiManualCompactionGuard({ maxTrackedSessions: 2, now: () => now })
    for (const sessionId of ['s1', 's2', 's3']) {
      now += 1_000
      guard.evaluate(sessionId, 3)
    }
    const tracked = ['s1', 's2', 's3'].filter((sessionId) => guard.inspect(sessionId) !== undefined)
    expect(tracked.length).toBeLessThanOrEqual(2)
  })
})

describe('createPiCompactionSkippedMessage', () => {
  test('带上可渲染的 subtype、原因与文案', () => {
    const message = createPiCompactionSkippedMessage('session-1', 'circuit_open', '最近连续压缩，已跳过。')
    expect(message).toEqual({
      type: 'system',
      subtype: PI_COMPACTION_SKIPPED_SUBTYPE,
      session_id: 'session-1',
      reason: 'circuit_open',
      message: '最近连续压缩，已跳过。',
    })
  })
})
