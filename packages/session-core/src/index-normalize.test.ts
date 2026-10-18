import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@profer/shared'
import { normalizeAgentRuntime } from '@profer/shared'
import { normalizeSessionIndexData } from './index-normalize'

function session(overrides: Record<string, unknown> = {}): AgentSessionMeta {
  return { id: 's1', title: 't', createdAt: 1, updatedAt: 1, ...overrides } as unknown as AgentSessionMeta
}

describe('会话索引归一', () => {
  test('文件缺失或损坏（null）返回空索引，且不报告清理', () => {
    expect(normalizeSessionIndexData(null)).toEqual({
      index: { version: 1, sessions: [] },
      removedLegacyKnowledgeReferences: false,
    })
  })

  test('sessions 不是数组时按空列表处理', () => {
    const result = normalizeSessionIndexData({ version: 1, sessions: 'bad' } as never)
    expect(result.index.sessions).toEqual([])
    expect(result.removedLegacyKnowledgeReferences).toBe(false)
  })

  test('缺失 agentRuntime 时补成规范值', () => {
    const result = normalizeSessionIndexData({ version: 1, sessions: [session()] })
    expect(result.index.sessions[0]?.agentRuntime).toBe(normalizeAgentRuntime(undefined))
  })

  test('下线前的 knowledgeReferences 被剔除并报告清理', () => {
    const legacy = session({ knowledgeReferences: [{ id: 'k' }] })
    const result = normalizeSessionIndexData({ version: 1, sessions: [legacy] })
    expect(Object.prototype.hasOwnProperty.call(result.index.sessions[0], 'knowledgeReferences')).toBe(false)
    expect(result.removedLegacyKnowledgeReferences).toBe(true)
  })

  test('无需改动的会话保持同一引用，不报告清理', () => {
    const clean = session({ agentRuntime: normalizeAgentRuntime(undefined) })
    const result = normalizeSessionIndexData({ version: 1, sessions: [clean] })
    expect(result.index.sessions[0]).toBe(clean)
    expect(result.removedLegacyKnowledgeReferences).toBe(false)
  })

  test('保留文件顶层的其他字段', () => {
    const result = normalizeSessionIndexData({ version: 7, sessions: [] } as never)
    expect(result.index.version).toBe(7)
  })
})
