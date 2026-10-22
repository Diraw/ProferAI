/**
 * agent-runtime-native-session-persistence 单测
 *
 * 关键证据：与**真实旧编排器**的 `onSessionId` / `onPiEntryBindings` 逐条对照，
 * 证明适配器复用旧规则而不是新造一套（不重写 provider，也不改 runtime core）。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, SDKMessage } from '@profer/shared'
import {
  createNativeSessionPersister,
  withNativeSessionCallbacks,
} from './agent-runtime-native-session-persistence'
import { createOldEngine } from './runtime-migration-parity/support/old-engine'
import { createParityHost } from './runtime-migration-parity/support/parity-host'

const input = () => ({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' as const })
const resultStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
  yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
})()

/** 取出真实旧编排器挂给 provider 的 onSessionId / onPiEntryBindings 回调。 */
async function oldProviderCallbacks(meta?: AgentSessionMeta) {
  const host = createParityHost({ runtime: 'pi', ...(meta ? { meta } : {}) })
  const old = createOldEngine({ host, input: input(), adapter: { query: resultStream } })
  await old.run()
  const options = old.recording.providerQueries[0] as {
    onSessionId?: (sdkSessionId: string, piSessionFile?: string) => void
    onPiEntryBindings?: (bindings: Record<string, string>) => void
  }
  return { host, options }
}

describe('与真实旧编排器的等价性', () => {
  test('首次原生 session id：两侧写出的 meta 补丁一致', async () => {
    const { host: oldHost, options } = await oldProviderCallbacks()
    options.onSessionId?.('native-session-1', 'pi-file.jsonl')
    const oldPatch = oldHost.session.metaPatches.at(-1)

    const newHost = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: newHost.sessions, sessionId: 'parity-session' })
    persister.onSessionId('native-session-1', 'pi-file.jsonl')
    const newPatch = newHost.session.metaPatches.at(-1)

    expect(newPatch).toEqual(oldPatch)
    expect(newPatch).toEqual({ sdkSessionId: 'native-session-1', piSessionFile: 'pi-file.jsonl', piEntryBindings: {} })
  })

  test('同一 session id 重复回调：两侧都不再写盘（避免每条消息 fsync 风暴）', async () => {
    const { host: oldHost, options } = await oldProviderCallbacks()
    options.onSessionId?.('native-session-1')
    const oldCountAfterFirst = oldHost.session.metaPatches.length
    options.onSessionId?.('native-session-1')
    expect(oldHost.session.metaPatches.length).toBe(oldCountAfterFirst)

    const newHost = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: newHost.sessions, sessionId: 'parity-session' })
    persister.onSessionId('native-session-1')
    const newCountAfterFirst = newHost.session.metaPatches.length
    persister.onSessionId('native-session-1')
    expect(newHost.session.metaPatches.length).toBe(newCountAfterFirst)
  })

  test('Pi artifact 更换：两侧都原子重置 piEntryBindings', async () => {
    const { host: oldHost, options } = await oldProviderCallbacks()
    options.onSessionId?.('native-session-1', 'pi-file-a.jsonl')
    options.onPiEntryBindings?.({ 'uuid-1': 'entry-1' })
    options.onSessionId?.('native-session-1', 'pi-file-b.jsonl')
    const oldPatch = oldHost.session.metaPatches.at(-1)

    const newHost = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: newHost.sessions, sessionId: 'parity-session' })
    persister.onSessionId('native-session-1', 'pi-file-a.jsonl')
    persister.onPiEntryBindings({ 'uuid-1': 'entry-1' })
    persister.onSessionId('native-session-1', 'pi-file-b.jsonl')
    const newPatch = newHost.session.metaPatches.at(-1)

    expect(newPatch).toEqual(oldPatch)
    expect(newPatch).toMatchObject({ sdkSessionId: 'native-session-1', piSessionFile: 'pi-file-b.jsonl', piEntryBindings: {} })
  })

  test('同一 artifact 重复回调：两侧都不重置 bindings', async () => {
    const { host: oldHost, options } = await oldProviderCallbacks()
    options.onSessionId?.('native-session-1', 'pi-file.jsonl')
    options.onPiEntryBindings?.({ 'uuid-1': 'entry-1' })
    const before = oldHost.session.metaPatches.length
    options.onSessionId?.('native-session-1', 'pi-file.jsonl')
    expect(oldHost.session.metaPatches.length).toBe(before)

    const newHost = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: newHost.sessions, sessionId: 'parity-session' })
    persister.onSessionId('native-session-1', 'pi-file.jsonl')
    persister.onPiEntryBindings({ 'uuid-1': 'entry-1' })
    const newBefore = newHost.session.metaPatches.length
    persister.onSessionId('native-session-1', 'pi-file.jsonl')
    expect(newHost.session.metaPatches.length).toBe(newBefore)
  })

  test('isolatedRuntimeSession：不落盘，只把原生 ID 透传给调用方', () => {
    const host = createParityHost({ runtime: 'pi' })
    const forwarded: Array<[string, string | undefined]> = []
    const persister = createNativeSessionPersister({
      sessions: host.sessions,
      sessionId: 'parity-session',
      isolatedRuntimeSession: true,
      onRuntimeSessionId: (sdkSessionId, piSessionFile) => forwarded.push([sdkSessionId, piSessionFile]),
    })
    persister.onSessionId('native-isolated-1', 'pi-file.jsonl')
    expect(host.session.metaPatches).toEqual([])
    expect(forwarded).toEqual([['native-isolated-1', 'pi-file.jsonl']])
    // 同一 id 再次回调不重复透传（旧路径仅在 isNewSessionId 时透传）。
    persister.onSessionId('native-isolated-1')
    expect(forwarded).toHaveLength(1)
  })
})

describe('onPiEntryBindings 合并', () => {
  test('增量合并到既有 bindings，并保留注入的检查点补丁', () => {
    const host = createParityHost({
      runtime: 'pi',
      meta: {
        id: 'parity-session',
        title: 't',
        agentRuntime: 'pi',
        createdAt: 1,
        updatedAt: 1,
        piEntryBindings: { 'uuid-0': 'entry-0' },
      },
    })
    const persister = createNativeSessionPersister({
      sessions: host.sessions,
      sessionId: 'parity-session',
      resolveCheckpointPatch: () => ({ piFileCheckpoints: { 'entry-1': '/tmp/checkpoint-1' } }),
    })
    persister.onPiEntryBindings({ 'uuid-1': 'entry-1' })
    expect(host.session.metaPatches.at(-1)).toEqual({
      piEntryBindings: { 'uuid-0': 'entry-0', 'uuid-1': 'entry-1' },
      piFileCheckpoints: { 'entry-1': '/tmp/checkpoint-1' },
    })
  })

  test('空 bindings 不写盘', () => {
    const host = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: host.sessions, sessionId: 'parity-session' })
    persister.onPiEntryBindings({})
    expect(host.session.metaPatches).toEqual([])
  })
})

describe('withNativeSessionCallbacks', () => {
  test('把回调并入既有 providerInput，保留原字段', () => {
    const persister = { onSessionId: () => {}, onPiEntryBindings: () => {} }
    const merged = withNativeSessionCallbacks({ permissionMode: 'plan' }, persister)
    expect(merged.permissionMode).toBe('plan')
    expect(typeof merged.onSessionId).toBe('function')
    expect(typeof merged.onPiEntryBindings).toBe('function')
  })

  test('providerInput 为 undefined 时也能构造', () => {
    const persister = { onSessionId: () => {}, onPiEntryBindings: () => {} }
    expect(Object.keys(withNativeSessionCallbacks(undefined, persister))).toEqual(['onSessionId', 'onPiEntryBindings'])
  })
})
