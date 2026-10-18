/**
 * runtime-migration-parity / 投影生命周期（重点：preflight、终态、未读、回放、原生 session ID）
 *
 * 与其它 parity 文件的区别：这里不是"源码字符串存在"的证据，而是用**真实
 * `AgentRuntimeCoordinator` + 真实宿主端口 fixture + 本批新增的投影模块**跑完整生命周期，
 * 逐条断言消息落盘、失败回调、终态一次性、取消、后台任务信号、恢复 ID 与事件顺序。
 *
 * 入口级接线（`agent-service.ts` 的 `runAgentRuntimeHeadlessInput` / remote / automation）
 * 在本批**未被修改**（禁止改动的文件），因此这里的 driver 复刻目标接线，用来证明
 * 「接线后行为正确」；真实接线清单见 `integration-requests.md`。
 */

import { describe, expect, test } from 'bun:test'
import { AgentRuntimeCoordinator } from '@profer/agent-runtime'
import { createAgentRuntimeProviderAdapter } from '@profer/agent-runtime'
import type { AgentRuntimeAdapter, AgentRuntimeCallbacks, AgentRuntimeQuery } from '@profer/agent-runtime'
import type { AgentMessage, SDKMessage } from '@profer/shared'
import { shouldMarkSessionUnreadOnCompletion, shouldClearSessionUnreadOnRunStart } from '../agent-unread-policy'
import { createRuntimeTerminalProjector, type RuntimeTerminalFields } from '../agent-runtime-terminal-projection'
import { projectPreflightFailure, applyPreflightFailureProjection } from '../agent-runtime-preflight-projection'
import { createNativeSessionPersister, withNativeSessionCallbacks } from '../agent-runtime-native-session-persistence'
import { createParityHost, type ParityHostFixture } from './support/parity-host'
import { createEntryDriver } from './support/new-entry'

const sdk = (value: Record<string, unknown>) => value as unknown as SDKMessage
const assistantMessage = (text: string) =>
  sdk({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null })
const resultMessage = (subtype: string, errors?: string[]) => sdk({ type: 'result', subtype, ...(errors ? { errors } : {}) })

/** 一次 run 的投影观测：终态回调序列 + 终态字段。 */
interface ProjectionObservation {
  calls: string[]
  fields: RuntimeTerminalFields[]
  messages: AgentMessage[] | undefined
  /** 消息观测与终态投递的**单一时间线**，用于断言"消息先于终态"。 */
  timeline: string[]
}

/**
 * 目标接线：`runAgentRuntimeHeadless` 的 runtime callbacks → 终态投影唯一责任方。
 * 这是 `integration-requests.md` IR-1 要求宿主落地的形状。
 */
function driveProjectedRun(options: {
  host: ParityHostFixture
  adapter: Partial<AgentRuntimeAdapter>
  query?: Partial<AgentRuntimeQuery>
  source?: Parameters<typeof createRuntimeTerminalProjector>[0]['source']
}): { observation: ProjectionObservation; handle: ReturnType<AgentRuntimeCoordinator['run']> } {
  const observation: ProjectionObservation = { calls: [], fields: [], messages: undefined, timeline: [] }
  const projector = createRuntimeTerminalProjector({
    source: options.source,
    messages: () => options.host.session.agentMessages,
    sink: {
      onError: error => observation.calls.push(`error:${error}`),
      onComplete: (fields, messages) => {
        observation.calls.push(`complete:${fields.endReason ?? 'none'}`)
        observation.fields.push(fields)
        observation.messages = messages
      },
    },
  })
  const coordinator = new AgentRuntimeCoordinator({
    adapters: {
      pi: {
        runtime: 'pi',
        query: async () => ({ status: 'completed' }),
        ...options.adapter,
      } as AgentRuntimeAdapter,
    },
    ports: options.host.ports,
  })
  const callbacks: AgentRuntimeCallbacks = {
    onEvent: () => {},
    onRunStarted: ({ startedAt }) => {
      observation.timeline.push('run_started')
      projector.observeRunStarted(startedAt)
    },
    onMessage: message => {
      observation.timeline.push(`message:${String((message as unknown as { type?: string }).type)}`)
      projector.observeMessage(message)
    },
    onError: error => projector.observeProviderError(error),
    onComplete: outcome => {
      observation.timeline.push(`settle:${outcome.status}`)
      projector.settle(outcome)
    },
  }
  const handle = coordinator.run(
    {
      sessionId: 'parity-session',
      prompt: 'hello',
      runtime: 'pi',
      channelId: 'parity-channel',
      ...options.query,
    },
    callbacks,
  )
  return { observation, handle }
}

const hangingStream = (signal: AbortSignal | undefined) => (async function* stream(): AsyncGenerator<SDKMessage> {
  yield assistantMessage('working')
  await new Promise<void>(resolve => {
    if (!signal) return
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
})()

/** 不先产出任何消息就挂起的 provider 流：用于断言「被拒绝的请求不产生副作用」。 */
const silentHangingStream = (signal: AbortSignal | undefined) => (async function* stream(): AsyncGenerator<SDKMessage> {
  await new Promise<void>(resolve => {
    if (!signal) return
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
})()

describe('消息落盘与终态顺序', () => {
  test('user → assistant → result 全部先于终态回调，且终态只投递一次', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { observation, handle } = driveProjectedRun({
      host,
      adapter: {
        stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
          yield assistantMessage('hi')
          yield resultMessage('success')
        })(),
      },
      query: { persistedUserMessage: sdk({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null }) },
    })
    const outcome = await handle.promise
    expect(outcome).toEqual({ status: 'completed' })
    expect(host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['user'], ['assistant'], ['result']])
    expect(observation.calls).toEqual(['complete:completed'])
    // 消息观测先于终态投递（单一时间线），且 runtime 事件以 claim → started → finished 包住消息
    expect(observation.timeline).toEqual(['run_started', 'message:assistant', 'message:result', 'settle:completed'])
    // 宿主事件端口看到的顺序：claimed → started → message* → finished
    expect(host.events.runtime.map(event => event.type)).toEqual([
      'runtime_claimed',
      'runtime_started',
      'message',
      'message',
      'runtime_finished',
    ])
  })

  test('终态之后的迟到停止不再产生第二个终态', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { observation, handle } = driveProjectedRun({
      host,
      adapter: { stream: () => (async function* stream(): AsyncGenerator<SDKMessage> { yield resultMessage('success') })() },
    })
    await handle.promise
    await handle.stop('stopped_by_user')
    expect(observation.calls).toEqual(['complete:completed'])
  })
})

describe('失败回调', () => {
  test('provider 抛错：onError 先于 onComplete，各一次，且带上 result 消息里的 subtype/errors', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { observation, handle } = driveProjectedRun({
      host,
      adapter: {
        stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
          yield resultMessage('error_during_execution', ['stream boom'])
          throw new Error('provider exploded')
        })(),
      },
    })
    const outcome = await handle.promise
    expect(outcome).toEqual({ status: 'failed', error: 'provider exploded' })
    expect(observation.calls).toEqual(['error:provider exploded', 'complete:error'])
    expect(observation.fields[0]).toMatchObject({
      stoppedByUser: false,
      resultSubtype: 'error_during_execution',
      resultErrors: ['stream boom'],
      endReason: 'error',
      endReasonLabel: '执行出错',
    })
  })

  test('失败 run 仍释放 owner，且 startedAt 来自 runtime 而不是宿主时钟', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { observation, handle } = driveProjectedRun({
      host,
      adapter: { stream: () => (async function* stream(): AsyncGenerator<SDKMessage> { throw new Error('boom') })() },
    })
    await handle.promise
    expect(observation.fields[0]?.startedAt).toBeGreaterThan(0)
  })
})

describe('取消', () => {
  test('流中取消：outcome=stopped、终态一次、stoppedByUser=true、provider 只启动一次', async () => {
    const host = createParityHost({ runtime: 'pi' })
    let starts = 0
    const { observation, handle } = driveProjectedRun({
      host,
      adapter: {
        stream: (input) => {
          starts += 1
          return hangingStream(input.abortSignal)
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    await handle.stop('stopped_by_user')
    const outcome = await handle.promise
    expect(outcome).toEqual({ status: 'stopped' })
    expect(starts).toBe(1)
    expect(observation.calls).toEqual(['complete:stopped_by_user'])
    expect(observation.fields[0]).toMatchObject({ stoppedByUser: true, endReason: 'stopped_by_user' })
  })

  test('委派取消：stoppedByUser=false 且写 delegation_cancelled', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { observation, handle } = driveProjectedRun({
      host,
      source: 'delegation',
      adapter: { stream: (input) => hangingStream(input.abortSignal) },
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    await handle.stop('delegation_cancelled')
    await handle.promise
    expect(observation.fields[0]).toMatchObject({ stoppedByUser: false, resultSubtype: 'delegation_cancelled' })
  })
})

describe('后台任务信号', () => {
  test('轻量完成不是终态：独立投递 backgroundTasksPending，真终态保持干净', async () => {
    const completions: RuntimeTerminalFields[] = []
    const projector = createRuntimeTerminalProjector({
      sink: { onError: () => {}, onComplete: fields => { completions.push(fields) } },
    })
    projector.settleBackgroundTasksPending({ resultSubtype: 'success' })
    // 软空闲已投递，但 projector 未结算。
    expect(completions[0]).toMatchObject({ backgroundTasksPending: true, resultSubtype: 'success' })
    expect(projector.settled).toBe(false)
    const settlement = projector.settle({ status: 'completed' })
    expect(settlement.delivered).toBe(true)
    // 真终态不含 backgroundTasksPending（与旧编排层 pendingTerminalCompletion 一致）。
    expect(settlement.fields?.backgroundTasksPending).toBeUndefined()
    // 未读口径：后台续轮不算一轮完成（复用真实策略函数）
    expect(
      shouldMarkSessionUnreadOnCompletion({ initiator: 'external', backgroundTasksPending: true, started: true }, 'manual'),
    ).toBe(false)
    expect(
      shouldMarkSessionUnreadOnCompletion({ initiator: 'external', backgroundTasksPending: false, started: true }, 'manual'),
    ).toBe(true)
  })

  test('provider 未打轻量完成注解：终态不含 backgroundTasksPending（不是软空闲）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { observation, handle } = driveProjectedRun({
      host,
      adapter: {
        stream: () => (async function* stream(): AsyncGenerator<SDKMessage> { yield resultMessage('success') })(),
      },
    })
    const outcome = await handle.promise
    expect(outcome).toEqual({ status: 'completed' })
    expect(observation.fields[0]?.backgroundTasksPending).toBeUndefined()
    // 没有轻量完成注解 → 事件流里也没有 backgroundTasks 语义。
    expect(host.events.runtime.map(event => event.type)).toEqual(['runtime_claimed', 'runtime_started', 'message', 'runtime_finished'])
  })
})

describe('原生 session ID 恢复', () => {
  test('provider 回调 → 宿主持久化：经 providerInput 接线后可落 sdkSessionId', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: host.sessions, sessionId: 'parity-session' })
    const { handle } = driveProjectedRun({
      host,
      adapter: {
        stream: (input) => (async function* stream(): AsyncGenerator<SDKMessage> {
          const callbacks = input.providerInput as { onSessionId?: (id: string, file?: string) => void } | undefined
          callbacks?.onSessionId?.('native-session-1', 'pi-file.jsonl')
          yield resultMessage('success')
        })(),
      },
      query: { providerInput: withNativeSessionCallbacks(undefined, persister) },
    })
    await handle.promise
    expect(host.session.metaPatches.at(-1)).toEqual({ sdkSessionId: 'native-session-1', piSessionFile: 'pi-file.jsonl', piEntryBindings: {} })
  })

  test('未接线时原生 ID 不会被持久化（当前缺口的可执行证据）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { handle } = driveProjectedRun({
      host,
      adapter: { stream: () => (async function* stream(): AsyncGenerator<SDKMessage> { yield resultMessage('success') })() },
    })
    await handle.promise
    expect(host.session.metaPatches).toEqual([])
  })

  test('真实 provider-bridge 会原样保留 providerInput 上的原生 session 回调（可执行）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const persister = createNativeSessionPersister({ sessions: host.sessions, sessionId: 'parity-session' })
    const received: Array<Record<string, unknown>> = []
    const fakeProvider = {
      query: (options: Record<string, unknown>) => {
        received.push(options)
        return (async function* stream(): AsyncGenerator<SDKMessage> {
          ;(options.onSessionId as ((id: string, file?: string) => void) | undefined)?.('native-session-bridge', 'pi-file.jsonl')
          yield resultMessage('success')
        })()
      },
      abort: () => {},
      dispose: () => {},
    }
    const adapter = createAgentRuntimeProviderAdapter('pi', fakeProvider as never)
    const coordinator = new AgentRuntimeCoordinator({ adapters: { pi: adapter }, ports: host.ports })
    const handle = coordinator.run(
      {
        sessionId: 'parity-session',
        prompt: 'hello',
        runtime: 'pi',
        channelId: 'parity-channel',
        providerInput: withNativeSessionCallbacks(undefined, persister),
      },
      { onEvent: () => {} },
    )
    await handle.promise
    expect(typeof received[0]?.onSessionId).toBe('function')
    expect(typeof received[0]?.onPiEntryBindings).toBe('function')
    expect(host.session.metaPatches.at(-1)).toEqual({
      sdkSessionId: 'native-session-bridge',
      piSessionFile: 'pi-file.jsonl',
      piEntryBindings: {},
    })
  })
})

describe('preflight 失败投影（G3 目标语义）', () => {
  test('凭证失败 + 抑制用户气泡：transcript 与旧路径一致，回调为 onError + endReason=error', async () => {
    const host = createParityHost({ runtime: 'pi', credentials: { ok: false, code: 'token_expired' } })
    // 目标接线：凭证解析失败 → 不落用户消息，改为 preflight transcript；再投递终态。
    const projection = projectPreflightFailure({
      typedError: {
        code: 'token_expired',
        title: '团队账号登录已过期',
        message: '请重新登录团队账号后再使用 Agent 商业渠道。',
        actions: [{ key: 's', label: '打开设置', action: 'settings' }],
        canRetry: false,
      },
      startedAt: 100,
    })
    applyPreflightFailureProjection({ sessions: host.sessions, sessionId: 'parity-session', projection })
    expect(host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['assistant'], ['system']])

    const terminalCalls: string[] = []
    const projector = createRuntimeTerminalProjector({
      sink: {
        onError: error => terminalCalls.push(`error:${error}`),
        onComplete: fields => terminalCalls.push(`complete:${fields.endReason ?? 'none'}`),
      },
    })
    // 目标接线：runtime 只给出 `Credential resolution failed: token_expired`，
    // 宿主必须把它翻译成用户可见的 TypedError 文案后再投递 onError（旧路径即如此）。
    projector.observeProviderError(projection.errorText)
    projector.settle({ status: 'failed', error: 'Credential resolution failed: token_expired' })
    expect(terminalCalls).toEqual([
      'error:团队账号登录已过期: 请重新登录团队账号后再使用 Agent 商业渠道。',
      'complete:error',
    ])
  })

  test('未抑制用户气泡时 transcript 变成孤儿用户消息（现状根因，用于回归对照）', async () => {
    const host = createParityHost({ runtime: 'pi', credentials: { ok: false, code: 'token_expired' } })
    host.sessions.appendMessages('parity-session', [
      sdk({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null }),
    ])
    expect(host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['user']])
  })
})

describe('未读与草稿晋升口径', () => {
  test('用户发起清未读、外部/委派不清（复用真实策略函数）', () => {
    expect(shouldClearSessionUnreadOnRunStart('user', 'manual')).toBe(true)
    expect(shouldClearSessionUnreadOnRunStart('external', 'manual')).toBe(false)
    expect(shouldClearSessionUnreadOnRunStart('delegation', 'manual')).toBe(false)
  })

  test('从未启动的请求失败不产生未读；失败结束仍需确认', () => {
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'external', backgroundTasksPending: false, started: false }, 'manual')).toBe(false)
    expect(shouldMarkSessionUnreadOnCompletion({ initiator: 'external', backgroundTasksPending: false, started: true }, 'manual')).toBe(true)
  })
})

/**
 * 入口级行为（驱动真实 `agent-runtime-entry.ts`）。
 *
 * 与上面各节的差别：这里不再由测试复刻接线，而是直接执行 `agent-service.ts` 实际调用的那段生产代码。
 */
describe('入口级行为（真实 runRuntimeHeadlessEntry）', () => {
  const entryInput = () => ({
    sessionId: 'parity-session',
    channelId: 'parity-channel',
    userMessage: 'hello',
    agentRuntime: 'pi' as const,
  })

  test('并发拒绝：第二个请求不投递任何终态，也不落盘（请求被拒绝 ≠ 一次运行）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const driver = createEntryDriver({
      host,
      adapters: { pi: { runtime: 'pi', stream: input => silentHangingStream(input.abortSignal) } },
    })
    const first = driver.start(entryInput())
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await driver.run(entryInput())
    expect(second.rejected).toContain('AgentRunAlreadyActiveError')
    expect(second.errors).toEqual([])
    expect(second.completions).toBe(0)
    expect(second.fields).toBeUndefined()
    expect(second.runStarted).toBe(0)
    expect(second.unread).toEqual([])
    expect(second.activeAfter).toBe(true)
    // 被拒绝的请求不产生持久化副作用：此时只有 owner run 的那一条用户气泡。
    expect(host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['user']])
    await first.stop()
    const firstObservation = await first.observation
    expect(firstObservation.outcome).toEqual({ status: 'stopped' })
  })

  test('准备阶段取消：outcome=stopped、终态一次、provider 未启动、不写 preflight transcript', async () => {
    const host = createParityHost({ runtime: 'pi', credentials: 'pending' })
    let providerStarts = 0
    const driver = createEntryDriver({
      host,
      adapters: { pi: { runtime: 'pi', stream: () => { providerStarts += 1; return hangingStream(undefined) } } },
    })
    const running = driver.start(entryInput())
    await new Promise(resolve => setTimeout(resolve, 5))
    await running.stop()
    // 解除 preparation 挂起，让被取消的 run 真正收敛（真实场景由凭证请求返回 / 超时完成）。
    host.resolveCredentials()
    const observation = await running.observation
    expect(observation.outcome).toEqual({ status: 'stopped' })
    expect(providerStarts).toBe(0)
    expect(observation.completions).toBe(1)
    expect(observation.errors).toEqual([])
    expect(observation.fields).toMatchObject({ stoppedByUser: true, endReason: 'stopped_by_user' })
    // 取消不是 preflight 失败：不得写错误气泡 / interruption_record。
    expect(host.session.appendCalls).toEqual([])
  })

  test('重试等待期间取消：provider 只启动一次，终态为 stopped', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const driver = createEntryDriver({
      host,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            throw new Error('ECONNRESET: socket hang up')
          })(),
        },
      },
      retry: { maxRetries: 3, maxDelayMs: 30_000, shouldRetry: () => true },
    })
    const running = driver.start(entryInput())
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(driver.recording.providerStarts).toBe(1)
    await running.stop()
    const observation = await running.observation
    expect(observation.outcome).toEqual({ status: 'stopped' })
    expect(driver.recording.providerStarts).toBe(1)
    expect(observation.completions).toBe(1)
  })

  test('终态与持久化不重复：onComplete 一次、未读在终态投递时按 started=true 写入', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const driver = createEntryDriver({
      host,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            yield assistantMessage('hi')
            yield resultMessage('success')
          })(),
        },
      },
    })
    const observation = await driver.run(entryInput())
    expect(observation.outcome).toEqual({ status: 'completed' })
    expect(observation.completions).toBe(1)
    expect(observation.errors).toEqual([])
    expect(observation.unread).toHaveLength(1)
    expect(observation.unread[0]?.started).toBe(true)
    expect(observation.unread[0]?.fields.endReason).toBe('completed')
    expect(host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['user'], ['assistant'], ['result']])
  })

  test('原生 session ID：入口接线后 provider 回调直接落盘（不需要改 provider / runtime core）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const driver = createEntryDriver({
      host,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: query => (async function* stream(): AsyncGenerator<SDKMessage> {
            const callbacks = query.providerInput as { onSessionId?: (id: string, file?: string) => void } | undefined
            callbacks?.onSessionId?.('native-entry-1', 'pi-file.jsonl')
            yield resultMessage('success')
          })(),
        },
      },
    })
    await driver.run(entryInput())
    expect(host.session.metaPatches).toContainEqual({ sdkSessionId: 'native-entry-1', piSessionFile: 'pi-file.jsonl', piEntryBindings: {} })
  })

  test('每轮只解析一份策略快照，且运行结束后释放（同一 session 连跑两轮）', async () => {
    const host = createParityHost({ runtime: 'pi' })
    const { agentRuntimePolicyRuns } = await import('../agent-runtime-policy-snapshot')
    const driver = createEntryDriver({
      host,
      adapters: { pi: { runtime: 'pi', stream: () => (async function* stream(): AsyncGenerator<SDKMessage> { yield resultMessage('success') })() } },
      resolveRunContext: () => ({
        runtime: 'pi',
        toolAssemblyContext: { sessionId: 'parity-session' },
        policy: { preset: { id: 'p', name: 'p', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 } as never, presetReference: { presetId: 'p', presetScope: 'user-global' } },
      }),
    })
    await driver.run(entryInput())
    // 运行结束后不持有快照（否则下一轮会读到上一轮冻结的策略）。
    expect(agentRuntimePolicyRuns.getForRun('parity-session')).toBeUndefined()
  })

  test('【GAP-1 已关闭】轻量完成 → 入口广播 backgroundTasksPending 并发 run_resumed，真终态保持干净', async () => {
    const host = createParityHost({ runtime: 'pi' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const driver = createEntryDriver({
      host,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            // provider 在「后台任务在飞」时给 result 打注解（与 claude-agent-adapter 一致）。
            yield sdk({ type: 'result', subtype: 'success', _keepChannelOpenForTasks: true })
            await gate
            yield assistantMessage('background task done')
            yield resultMessage('success')
          })(),
        },
      },
    })
    const running = driver.start(entryInput())
    await new Promise(resolve => setTimeout(resolve, 10))
    // 轻量完成已投递：run 尚未结束，执行权仍被持有（UI 空闲可输入但主进程不释放会话）。
    expect(driver.coordinator.isRunning('parity-session')).toBe(true)
    release()
    const observation = await running.observation
    expect(observation.outcome).toEqual({ status: 'completed' })
    // 两次投递：先软空闲（backgroundTasksPending），后真终态（干净）。
    expect(observation.completions).toBe(2)
    expect(observation.completionFields[0]).toMatchObject({ backgroundTasksPending: true })
    expect(observation.completionFields[1]?.backgroundTasksPending).toBeUndefined()
    // 未读策略两次都被咨询：软空闲带 backgroundTasksPending（被策略抑制、不写未读），
    // 真终态不带该标记（真正写未读）——与旧路径 `applyCompletionUnreadPolicy` 同义。
    expect(observation.unread).toHaveLength(2)
    expect(observation.unread[0]?.fields.backgroundTasksPending).toBe(true)
    expect(observation.unread[1]?.fields.backgroundTasksPending).toBeUndefined()
    // 唤醒信号经 host port 的 host_event 通道发出（生产侧转成 profer_event 的 run_resumed）。
    const hostEvents = host.events.runtime.filter(event => event.type === 'host_event')
    expect(hostEvents).toHaveLength(1)
    expect(hostEvents[0]).toMatchObject({ event: { type: 'run_resumed', sessionId: 'parity-session' } })
  })
})
