import { describe, expect, test } from 'bun:test'
import { canSelectAgentSessionRuntime } from './agent-session-runtime'

describe('会话内核绑定策略', () => {
  test('旧会话缺省字段和未加载会话保持锁定，不跟随全局默认', () => {
    expect(canSelectAgentSessionRuntime(undefined)).toBe(false)
    expect(canSelectAgentSessionRuntime({})).toBe(false)
    expect(canSelectAgentSessionRuntime({ draft: false })).toBe(false)
  })

  test('新空会话与历史空草稿允许选择，明确锁定优先于草稿', () => {
    expect(canSelectAgentSessionRuntime({ agentRuntimeLocked: false })).toBe(true)
    expect(canSelectAgentSessionRuntime({ draft: true })).toBe(true)
    expect(canSelectAgentSessionRuntime({ draft: true, agentRuntimeLocked: true })).toBe(false)
  })

  test('原生恢复和分叉资产不能因草稿或未锁标记而换内核', () => {
    for (const assets of [
      { sdkSessionId: 'native' }, { piSessionFile: '/pi/session.jsonl' },
      { piEntryBindings: { message: 'entry' } }, { piFileCheckpoints: { entry: '/checkpoint' } },
      { forkSourceSdkSessionId: 'source' }, { forkSourceDir: '/source' },
      { resumeAtMessageUuid: 'resume' }, { parentSessionId: 'parent' },
      { explorationParentSessionId: 'source' }, { sourceAutomationId: 'automation' },
    ]) {
      expect(canSelectAgentSessionRuntime({ draft: true, agentRuntimeLocked: false, ...assets })).toBe(false)
    }
    expect(canSelectAgentSessionRuntime({ draft: true, piEntryBindings: {}, piFileCheckpoints: {} })).toBe(true)
  })
})
