/**
 * runtime-migration-parity / 恢复、原生 session ID、Goal 回调、artifact/checkpoint（重点 6）
 *
 * 这些能力与"入口"强相关：切换入口会改变责任方。本文件对每一项给出：
 * - 可执行证据（真实函数 / 真实 run 的可观察结果）；
 * - 或明确的"责任方缺失/接缝需求"记录（不把静态缺失伪装成已验证）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SDKMessage } from '@profer/shared'
import { countOccurrences, readMainSource, sliceBetween } from './support/compile-slice'
import { createNewEngine } from './support/new-engine'
import { createOldEngine } from './support/old-engine'
import { createParityHost } from './support/parity-host'

const input = () => ({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' as const })
const resultStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
  yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
})()

const agentServiceSource = readMainSource('agent-service.ts')
const orchestratorSource = readMainSource('agent-orchestrator.ts')
const coordinatorSource = readFileSyncCoordinator()

function readFileSyncCoordinator(): string {
  return readRepoSource('packages/agent-runtime/src/coordinator.ts')
}

/** 从本文件位置读取仓库内任意文件（`..` 六级到仓库根）。 */
function readRepoSource(relativeFromRoot: string): string {
  return readFileSync(new URL(`../../../../../../${relativeFromRoot}`, import.meta.url), 'utf8')
}

describe('原生 session ID 持久化', () => {
  test('旧路径：provider 的 onSessionId 回调把 sdkSessionId / piSessionFile 落到会话元数据（可执行）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const old = createOldEngine({ host, input: input(), adapter: { query: resultStream } })
    await old.run()
    const queryOptions = old.recording.providerQueries[0] as { onSessionId?: (sdkSessionId: string, piSessionFile?: string) => void }
    expect(typeof queryOptions.onSessionId).toBe('function')
    queryOptions.onSessionId?.('native-session-1', 'pi-file.jsonl')
    const patch = host.session.metaPatches.at(-1)
    expect(patch).toMatchObject({ sdkSessionId: 'native-session-1', piSessionFile: 'pi-file.jsonl' })
    expect(host.session.meta?.sdkSessionId).toBe('native-session-1')
  })

  test('新路径：coordinator 不承担原生 session ID 持久化（责任方=宿主；本批已提供宿主侧适配器）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: resultStream } } })
    await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(host.session.metaPatches).toEqual([])
    // coordinator 只通过 SessionPort 落消息与锁内核；没有 onSessionId 桥接。
    expect(countOccurrences(coordinatorSource, 'sdkSessionId')).toBe(0)
    expect(countOccurrences(coordinatorSource, 'onSessionId')).toBe(0)
  })

  test('宿主侧适配器可复现旧回调语义，且不需要改 provider / runtime core（可执行）', async () => {
    const { createNativeSessionPersister, withNativeSessionCallbacks } = await import('../agent-runtime-native-session-persistence')
    const host = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: host.sessions, sessionId: 'parity-session' })
    // provider 已有的回调签名（Pi: (id, sessionFile)；Claude: (id)）直接挂上，不重写 provider。
    const providerInput = withNativeSessionCallbacks(undefined, persister)
    expect(typeof providerInput.onSessionId).toBe('function')
    ;(providerInput.onSessionId as (id: string, file?: string) => void)('native-session-1', 'pi-file.jsonl')
    expect(host.session.metaPatches.at(-1)).toEqual({
      sdkSessionId: 'native-session-1',
      piSessionFile: 'pi-file.jsonl',
      piEntryBindings: {},
    })
  })

  test('新路径只把既有 runtimeSessionId 作为 resumeSessionId 透传（可执行）', async () => {
    const preparation = await import('../agent-runtime-provider-preparation')
    const port = preparation.createElectronProviderQueryPreparation()
    const prepared = await port.prepare(
      { sessionId: 's', prompt: 'p', runtime: 'pi', runtimeSessionId: 'native-session-1' } as never,
      { credentials: { apiKey: 'k', baseUrl: undefined, provider: 'custom', forceBearerAuth: false } } as never,
      new AbortController().signal,
    )
    expect((prepared as Record<string, unknown>).resumeSessionId).toBe('native-session-1')
  })
})

describe('流恢复（renderer 刷新后回放活跃 run）', () => {
  test('旧/新入口共用 isAgentExecutionActive，恢复快照要求会话仍活跃（源码证据）', () => {
    expect(agentServiceSource).toContain('export function restoreActiveAgentStreams(')
    expect(agentServiceSource).toContain('if (!isAgentExecutionActive(sessionId) && !completedStreamEventBacklogs.has(sessionId)) continue')
    expect(agentServiceSource).toContain('function isAgentExecutionActive(sessionId: string): boolean')
    expect(agentServiceSource).toContain('return orchestrator.isActive(sessionId) || runtimeCoordinator.isRunning(sessionId)')
    expect(agentServiceSource).toContain('beginActiveStreamBacklog(input.sessionId)')
    expect(agentServiceSource).toContain('finishActiveStreamBacklog(input.sessionId)')
  })

  test('direct runtime 入口（remote / automation）经共享入口注册桌面 backlog；Pocket 侧刷新回放已由 remote 侧登记（服务端已关闭）', () => {
    const remoteBranch = sliceBetween(readMainSource('remote-service.ts'), 'const useRuntimeRemote = process.env.PROFER_RUNTIME_REMOTE', 'void runtimeRun.catch', 'remote-branch')
    expect(remoteBranch).not.toContain('beginActiveStreamBacklog')
    expect(remoteBranch).not.toContain('registerWebContents')
    const automationBranch = sliceBetween(readMainSource('automation-scheduler.ts'), 'const useRuntimeAutomation = process.env.PROFER_RUNTIME_AUTOMATION', 'runtimeRun.catch', 'automation-branch')
    expect(automationBranch).not.toContain('beginActiveStreamBacklog')
    // 两个新分支都调用 runAgentRuntimeHeadless，后者内部才登记 backlog（接线后三入口共用同一份责任）。
    expect(remoteBranch).toContain('runAgentRuntimeHeadless(')
    expect(automationBranch).toContain('runAgentRuntimeHeadless(')
    const agentServiceSource = readMainSource('agent-service.ts')
    const entrySlice = sliceBetween(agentServiceSource, 'export async function runAgentRuntimeHeadless(', 'export async function stopAgentRuntime(', 'runtime-entry')
    expect(entrySlice).toContain('beginActiveStreamBacklog(input.sessionId)')
    expect(entrySlice).toContain('finishActiveStreamBacklog(input.sessionId)')
    // 2026-10-16 集成会话：remote 侧已补客户端绑定与会话级回放登记（GAP-3 服务端关闭）；
    // 仍缺的是 Pocket（独立仓库）发 `restore_agent_streams` —— 属客户端配合，见集成报告。
    const remoteSource = readMainSource('remote-service.ts')
    expect(remoteSource).toContain('restore_agent_streams')
    expect(remoteSource).toContain('agent_streams_restored')
    expect(remoteSource).toContain("from './remote-agent-replay-registry'")
    // 仍不复制桌面机制：remote 不直接用 `restoreActiveAgentStreams` / `registerWebContents`。
    expect(remoteSource).not.toContain('restoreActiveAgentStreams')
    expect(remoteBranch).not.toContain('restoreActiveAgentStreams')
  })
})

describe('Goal 回调面', () => {
  test('新 runtime 契约里没有 Goal 专用回调字段（缺口，Goal 必须留旧路径）', () => {
    const contractSource = readRepoSource('packages/agent-runtime/src/contract.ts')
    for (const field of ['onRuntimeSessionId', 'onRuntimeMessage', 'reportGoalResult', 'goalRunId']) {
      expect(countOccurrences(contractSource, field)).toBe(0)
    }
    expect(agentServiceSource).toContain('&& !input.goalRunId')
    expect(agentServiceSource).toContain('&& !input.reportGoalResult')
    expect(agentServiceSource).toContain('&& !input.onRuntimeSessionId')
    expect(agentServiceSource).toContain('&& !input.onRuntimeMessage')
  })

  test('旧路径仅在 isolatedRuntimeSession 时透传原生 session id，onRuntimeMessage 始终透传（源码证据）', () => {
    expect(orchestratorSource).toContain('onRuntimeMessage: input.onRuntimeMessage')
    const isolatedBlock = sliceBetween(orchestratorSource, '...(input.isolatedRuntimeSession && {', "}),\n        // 回退后 resume", 'isolated-runtime-session')
    expect(isolatedBlock).toContain('isolatedRuntimeSession: true')
    expect(isolatedBlock).toContain('onRuntimeSessionId: input.onRuntimeSessionId')
  })
})

describe('artifact / checkpoint', () => {
  test('旧路径：Pi 每轮创建文件检查点并在落盘后绑定 entry（源码证据）', () => {
    expect(orchestratorSource).toContain('piTurnCheckpoint = createPiFileCheckpoint(sessionId, agentCwd, piCheckpointRoot)')
    expect(orchestratorSource).toContain('onPiEntryBindings: (bindings: Record<string, string>) =>')
    expect(orchestratorSource).toContain('piFileCheckpoints: keptCheckpoints')
    // 检查点失败不能阻断本轮：真实代码把创建包在 try/catch 内。
    expect(orchestratorSource).toContain('Pi 文件检查点创建失败，本轮继续但不可文件回退')
  })

  test('新 runtime 包没有任何 checkpoint / artifact 概念（缺口）', () => {
    const checkpointHits = ['checkpoint', 'Checkpoint'].reduce((sum, token) => sum + countOccurrences(coordinatorSource, token), 0)
    expect(checkpointHits).toBe(0)
    expect(countOccurrences(coordinatorSource, 'piEntryBindings')).toBe(0)
    expect(countOccurrences(coordinatorSource, 'piSessionFile')).toBe(0)
  })

  test('集成会话已把检查点生命周期接进入口（GAP-2 关闭证据：入口持有注入位，宿主提供实现）', async () => {
    const { createNativeSessionPersister } = await import('../agent-runtime-native-session-persistence')
    const host = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: host.sessions, sessionId: 'parity-session' })
    persister.onPiEntryBindings({ 'uuid-1': 'entry-1' })
    // 不注入 resolveCheckpointPatch 时，只合并 bindings，不触碰 piFileCheckpoints。
    expect(host.session.metaPatches.at(-1)).toEqual({ piEntryBindings: { 'uuid-1': 'entry-1' } })
    // 回收策略已由宿主持有模块实现，并在 run 起点（provider 启动前）创建。
    expect(orchestratorSource).toContain('prunePiFileCheckpoints')
    expect(countOccurrences(coordinatorSource, 'prunePiFileCheckpoints')).toBe(0)
    const entrySource = readMainSource('agent-runtime-entry.ts')
    expect(entrySource).toContain('checkpointLifecycle: checkpointTurn')
    expect(entrySource).toContain('context.checkpointTurn')
    const agentServiceSource = readMainSource('agent-service.ts')
    expect(agentServiceSource).toContain('beginPiCheckpointTurn({ sessionId: input.sessionId, cwd })')
    // cwd 与旧链同源：会话级工作目录，无 workspace 时回退用户主目录（不再是可选 cwd）。
    expect(agentServiceSource).toContain('getAgentSessionWorkspacePath(workspaceSlug, input.sessionId) : homedir()')
  })
})

describe('未读 / 草稿晋升投影', () => {
  test('两侧入口共用同一未读策略实现（源码证据 + 真实判定函数行为）', async () => {
    const [{ shouldClearSessionUnreadOnRunStart, shouldMarkSessionUnreadOnCompletion }] = await Promise.all([
      import('../agent-unread-policy'),
    ])
    // 旧入口（runAgent / runAgentHeadless）与新入口（runAgentRuntimeHeadless）都调用同一对函数。
    expect(countOccurrences(agentServiceSource, 'applyRunStartUnreadPolicy(')).toBeGreaterThanOrEqual(1)
    expect(countOccurrences(agentServiceSource, 'applyCompletionUnreadPolicy(')).toBeGreaterThanOrEqual(1)
    expect(agentServiceSource).toContain('const runtimeCallbacks: AgentRuntimeCallbacks = {')
    expect(agentServiceSource).toContain('if (input.initiator) applyRunStartUnreadPolicy(input.sessionId, input.initiator)')

    // 真实判定函数：用户发起清未读；外部/委派不清。
    expect(shouldClearSessionUnreadOnRunStart('user', 'manual')).toBe(true)
    expect(shouldClearSessionUnreadOnRunStart('external', 'manual')).toBe(false)
    expect(shouldClearSessionUnreadOnRunStart('delegation', 'manual')).toBe(false)
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'external', backgroundTasksPending: false, started: true }, 'manual')).toBe(true)
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'external', backgroundTasksPending: false, started: false }, 'manual')).toBe(false)
  })

  test('草稿晋升只发生在新入口的 onRunStarted 与旧入口的 onRunStarted（两侧同一语义）', () => {
    expect(agentServiceSource).toContain('const beforePromotion = getAgentSessionMeta(input.sessionId)')
    expect(countOccurrences(agentServiceSource, 'draft: false')).toBeGreaterThanOrEqual(2)
    expect(agentServiceSource).toContain('publishAgentSessionProjection(session)')
  })
})
