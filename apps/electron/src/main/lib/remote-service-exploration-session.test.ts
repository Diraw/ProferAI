import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@profer/shared'
import {
  buildSessionItem,
  DEFAULT_EXPLORATION_SOURCE_LABEL,
  EXPLORATION_SOURCE_LABEL_MAX_LENGTH,
  handleRemoteCommand,
  normalizeExplorationSourceLabel,
} from './remote-service'

/**
 * 跨端同步波次 · 工作线 A（桌面侧）的代码级验证。
 *
 * 覆盖两件事：
 *  - T1：`buildSessionItem()` 是否把探索血缘三字段下沉给移动端（验收 A-1）；
 *  - T2：`create_exploration_session` 命令的参数校验与错误语义（验收 A-7/A-8 的错误面）。
 *
 * 真机端到端（A-6/A-9）需在双端联调阶段补充，不在此处伪造。
 */

function makeSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1',
    title: '测试会话',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('buildSessionItem：探索血缘字段透传', () => {
  test('探索分支的三个血缘字段一并下发', () => {
    const item = buildSessionItem(makeSession({
      explorationParentSessionId: 'parent-1',
      explorationSourceMessageId: 'uuid-1',
      explorationSourceLabel: '这条 Agent 回复',
      // 主进程内部守卫不属 UI 数据，不得出现在下发行里
      explorationTitleInitializedAt: 123456,
    }))

    expect(item.explorationParentSessionId).toBe('parent-1')
    expect(item.explorationSourceMessageId).toBe('uuid-1')
    expect(item.explorationSourceLabel).toBe('这条 Agent 回复')
    expect('explorationTitleInitializedAt' in item).toBe(false)
  })

  test('普通会话与普通 fork 不携带探索血缘（避免被误判为探索分支）', () => {
    const plain = buildSessionItem(makeSession())
    expect(plain.explorationParentSessionId).toBeUndefined()
    expect(plain.explorationSourceMessageId).toBeUndefined()
    expect(plain.explorationSourceLabel).toBeUndefined()

    // 普通 fork：parentSessionId 有值而探索字段必须保持 undefined
    const forked = buildSessionItem(makeSession({ forkSourceDir: 'C:/tmp/fork-src' }))
    expect(forked.explorationParentSessionId).toBeUndefined()
    expect(forked.explorationSourceMessageId).toBeUndefined()
  })

  test('委派血缘字段不受影响（与探索血缘是两套独立字段）', () => {
    const item = buildSessionItem(makeSession({
      parentSessionId: 'delegator-1',
      sourceDelegationId: 'delegation-1',
    }))
    expect(item.parentSessionId).toBe('delegator-1')
    expect(item.sourceDelegationId).toBe('delegation-1')
    expect(item.explorationParentSessionId).toBeUndefined()
  })
})

describe('normalizeExplorationSourceLabel：来源标签服务端归一化', () => {
  test('非字符串与空白值回落缺省标签', () => {
    expect(normalizeExplorationSourceLabel(undefined)).toBe(DEFAULT_EXPLORATION_SOURCE_LABEL)
    expect(normalizeExplorationSourceLabel(null)).toBe(DEFAULT_EXPLORATION_SOURCE_LABEL)
    expect(normalizeExplorationSourceLabel(42)).toBe(DEFAULT_EXPLORATION_SOURCE_LABEL)
    expect(normalizeExplorationSourceLabel('')).toBe(DEFAULT_EXPLORATION_SOURCE_LABEL)
    expect(normalizeExplorationSourceLabel('   \n\t ')).toBe(DEFAULT_EXPLORATION_SOURCE_LABEL)
  })

  test('折叠连续空白（含换行）并去首尾空白', () => {
    expect(normalizeExplorationSourceLabel('  文件 ·\n  main.ts  ')).toBe('文件 · main.ts')
  })

  test('超过 120 字符时截断（避免超长选区文本随 session_updated 反复广播）', () => {
    const long = '探'.repeat(200)
    const normalized = normalizeExplorationSourceLabel(long)
    expect(normalized).toHaveLength(EXPLORATION_SOURCE_LABEL_MAX_LENGTH)
    expect(long.startsWith(normalized)).toBe(true)
  })

  test('恰好 120 字符不截断', () => {
    const exact = '探'.repeat(EXPLORATION_SOURCE_LABEL_MAX_LENGTH)
    expect(normalizeExplorationSourceLabel(exact)).toBe(exact)
  })
})

describe('create_exploration_session：参数校验与错误语义', () => {
  test('命令已注册（不再是「未知指令」）', async () => {
    const result = await handleRemoteCommand(JSON.stringify({ type: 'create_exploration_session' }), 1)
    expect(result).toEqual({ ok: false, error: '缺少 sessionId 或 upToMessageUuid' })
  })

  test('缺少 upToMessageUuid 时报错', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({ type: 'create_exploration_session', sessionId: 'session-1' }),
      1,
    )
    expect(result).toEqual({ ok: false, error: '缺少 sessionId 或 upToMessageUuid' })
  })

  test('纯空白参数按缺失处理', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({ type: 'create_exploration_session', sessionId: '  ', upToMessageUuid: '\n' }),
      1,
    )
    expect(result).toEqual({ ok: false, error: '缺少 sessionId 或 upToMessageUuid' })
  })

  test('源会话不存在时透传可读中文错误，且不返回部分成功 data', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({
        type: 'create_exploration_session',
        sessionId: '__profer_nonexistent_session_for_test__',
        upToMessageUuid: 'uuid-1',
      }),
      1,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('源 Agent 会话不存在: __profer_nonexistent_session_for_test__')
    expect('data' in result).toBe(false)
  })
})
