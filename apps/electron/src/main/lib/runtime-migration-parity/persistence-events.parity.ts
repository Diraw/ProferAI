/**
 * runtime-migration-parity / 持久化与终态判定对照（重点 4）
 *
 * 覆盖：消息持久化（哪些消息、什么顺序）、result 与 iterator done 的关系、
 * backgroundTasksPending 与终态的区别、事件顺序。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { createAgentRunOutcomeReporter } from '@profer/agent-runtime'
import { createNewEngine } from './support/new-engine'
import { createEntryDriver } from './support/new-entry'
import { createOldEngine } from './support/old-engine'
import { createParityHost } from './support/parity-host'
import { readMainSource } from './support/compile-slice'

const input = () => ({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' as const })

function sdk(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage
}

const assistant = () => sdk({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null })

async function driveOld(stream: () => AsyncGenerator<SDKMessage>) {
  const host = createParityHost({ runtime: 'pi' })
  const old = createOldEngine({ host, input: input(), adapter: { query: stream } })
  const observation = await old.run()
  return { host, old, observation }
}

async function driveNew(stream: () => AsyncGenerator<SDKMessage>) {
  const host = createParityHost({ runtime: 'pi' })
  const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream } } })
  const observation = await engine.run({
    sessionId: 'parity-session',
    channelId: 'parity-channel',
    persistedUserMessage: sdk({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null }),
  })
  return { host, engine, observation }
}

/**
 * 入口级 driver：驱动真实 `runRuntimeHeadlessEntry`（生产入口接线）。
 * G3 的修复在**入口**（preflight 投影 + 用户气泡抑制），因此门槛必须在入口层取证。
 */
async function driveEntry(
  stream: () => AsyncGenerator<SDKMessage>,
  options: { credentials?: 'ok' | { ok: false; code: 'token_expired' | 'api_key_decrypt_failed' } } = {},
) {
  const host = createParityHost({ runtime: 'pi', ...(options.credentials ? { credentials: options.credentials } : {}) })
  const driver = createEntryDriver({ host, adapters: { pi: { runtime: 'pi', stream } } })
  const observation = await driver.run({
    sessionId: 'parity-session',
    channelId: 'parity-channel',
    userMessage: 'hello',
    agentRuntime: 'pi',
  })
  return { host, driver, observation }
}

describe('消息持久化', () => {
  test('正常一轮：两侧都持久化 user/assistant/result，且都发生在 provider 终态之前', async () => {
    const oldRun = await driveOld(async function* () { yield assistant(); yield sdk({ type: 'result', subtype: 'success' }) })
    expect(oldRun.host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['user'], ['assistant'], ['result']])

    const newRun = await driveNew(async function* () { yield assistant(); yield sdk({ type: 'result', subtype: 'success' }) })
    expect(newRun.host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['user'], ['assistant'], ['result']])
    expect(newRun.observation.outcome).toEqual({ status: 'completed' })
  })

  test('两侧持久化与凭证解析的相对顺序一致：lock → 凭证解析 → 落盘用户消息（已修复）', async () => {
    const oldRun = await driveOld(async function* () { yield sdk({ type: 'result', subtype: 'success' }) })
    const oldLog = oldRun.host.log
    // 旧路径：先解析凭证（步骤 2），成功后才写用户消息（步骤 5）。
    expect(oldLog.indexOf('session.lock:pi')).toBeLessThan(oldLog.indexOf('credentials.resolve:pi'))
    expect(oldLog.indexOf('credentials.resolve:pi')).toBeLessThan(oldLog.indexOf('session.append:parity-session:1'))

    const newRun = await driveEntry(async function* () { yield sdk({ type: 'result', subtype: 'success' }) })
    const newLog = newRun.host.log
    // 修复前：新路径先落盘用户消息再解析凭证（凭证失败留下孤儿用户气泡）。
    // 修复后：落盘时机后移到准备成功之后，与旧路径同序。
    expect(newLog.indexOf('session.lock:pi')).toBeLessThan(newLog.indexOf('credentials.resolve:pi'))
    expect(newLog.indexOf('credentials.resolve:pi')).toBeLessThan(newLog.indexOf('session.append:parity-session:1'))
    expect(newLog.indexOf('credentials.resolve:pi')).toBeLessThan(newLog.indexOf('host:runtime_finished'))
  })

  test('【切换门槛】凭证失败后落盘的 transcript 应与旧路径一致（已修复：入口 preflight 投影）', async () => {
    const oldHost = createParityHost({ runtime: 'pi', credentials: { ok: false, code: 'token_expired' } })
    const old = createOldEngine({ host: oldHost, input: input(), adapter: { query: async function* () {} } })
    const oldObservation = await old.run()

    const newRun = await driveEntry(async function* () {}, { credentials: { ok: false, code: 'token_expired' } })
    const kinds = (host: ReturnType<typeof createParityHost>) => host.session.appendCalls.map(batch => batch.map(message => message.type))
    // 门槛：凭证失败这种 preflight 失败在两个入口应产生相同的持久化结果。
    expect(kinds(newRun.host)).toEqual(kinds(oldHost))
    expect(kinds(newRun.host)).toEqual([['assistant'], ['system']])
    // 用户可见文案与终态口径也一致（不是 runtime 的机械文本）。
    expect(newRun.observation.errors).toEqual(oldObservation.errors)
    expect(newRun.observation.fields?.endReason).toBe('error')
    expect(newRun.observation.fields?.endReasonLabel).toBe('执行出错')
    expect(newRun.host.session.metaPatches.at(-1)).toMatchObject({ lastInterruptReason: 'error' })
  })

  test('现状记录（已修复）：凭证失败在两侧都留下错误 transcript 且没有孤儿用户气泡', async () => {
    const oldHost = createParityHost({ runtime: 'pi', credentials: { ok: false, code: 'token_expired' } })
    const old = createOldEngine({ host: oldHost, input: input(), adapter: { query: async function* () {} } })
    const oldObservation = await old.run()
    expect(oldHost.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['assistant'], ['system']])
    expect(oldObservation.errors).toEqual(['团队账号登录已过期: 请重新登录团队账号后再使用 Agent 商业渠道。'])
    expect(oldObservation.completions[0]?.endReason).toBe('error')

    const newRun = await driveEntry(async function* () {}, { credentials: { ok: false, code: 'token_expired' } })
    // 修复前：新路径只落 `[['user']]`（孤儿用户气泡）且用户只能看到机械文案。
    // 修复后：与旧路径逐条一致。
    expect(newRun.host.session.appendCalls.map(batch => batch.map(message => message.type))).toEqual([['assistant'], ['system']])
    expect(newRun.observation.outcome).toEqual({ status: 'failed', error: 'Credential resolution failed: token_expired' })
    expect(newRun.observation.errors).toEqual(['团队账号登录已过期: 请重新登录团队账号后再使用 Agent 商业渠道。'])
  })

  test('持久化失败：两侧都不启动 provider，且不留下 owner（新路径以准备失败终态返回）', async () => {
    const oldHost = createParityHost({ runtime: 'pi', appendMessagesFailure: 'persist failed' })
    const old = createOldEngine({ host: oldHost, input: input(), adapter: { query: async function* () { yield sdk({ type: 'result', subtype: 'success' }) } } })
    const oldObservation = await old.run()
    expect(oldObservation.activeAfter).toBe(false)
    expect(oldObservation.providerStarts).toBe(0)

    const newHost = createParityHost({ runtime: 'pi', appendMessagesFailure: 'persist failed' })
    const engine = createNewEngine({ host: newHost, adapters: { pi: { runtime: 'pi', stream: async function* () { yield sdk({ type: 'result', subtype: 'success' }) } } } })
    const observation = await engine.run({
      sessionId: 'parity-session',
      channelId: 'parity-channel',
      persistedUserMessage: sdk({ type: 'user', message: { content: [] }, parent_tool_use_id: null }),
    })
    expect(observation.activeAfter).toBe(false)
    expect(observation.providerStarts).toBe(0)
    // 变更点：用户消息落盘时机后移后，失败不再 reject，而是以「准备失败」终态返回。
    expect(observation.outcome).toEqual({ status: 'failed', error: 'persist failed' })
  })
})

describe('result 与 iterator done', () => {
  test('有 result 再 iterator done：两侧都 completed', async () => {
    const oldRun = await driveOld(async function* () { yield assistant(); yield sdk({ type: 'result', subtype: 'success' }) })
    expect(oldRun.observation.completions[0]?.endReason).toBe('completed')

    const newRun = await driveNew(async function* () { yield assistant(); yield sdk({ type: 'result', subtype: 'success' }) })
    expect(newRun.observation.outcome).toEqual({ status: 'completed' })
  })

  test('只有 iterator done、没有 result：两侧都算 completed（一致）', async () => {
    const oldRun = await driveOld(async function* () { yield assistant() })
    const newRun = await driveNew(async function* () { yield assistant() })
    // 旧：`normalizeAgentEndReason` 把无 result 的 iterator 结束归一为 completed。
    expect(oldRun.observation.completions[0]?.endReason).toBe('completed')
    // 新：`consumeRuntimeStream` 在无 result 时也返回 completed。
    expect(newRun.observation.outcome).toEqual({ status: 'completed' })
  })

  test('result subtype 失败：两侧都判失败，且错误文本来源一致（result.errors）', async () => {
    const oldRun = await driveOld(async function* () { yield sdk({ type: 'result', subtype: 'error_during_execution', errors: ['boom-old'] }) })
    expect(oldRun.observation.completions[0]?.endReason).toBe('error')
    expect(oldRun.observation.completions[0]?.resultSubtype).toBe('error_during_execution')

    const newRun = await driveNew(async function* () { yield sdk({ type: 'result', subtype: 'error_during_execution', errors: ['boom-new'] }) })
    expect(newRun.observation.outcome).toEqual({ status: 'failed', error: 'boom-new' })
  })

  // 口径说明（2026-10-15 集成会话修正）：旧/新两条执行链在这一输入上**结果一致**（都 completed），
  // 真正的分歧在“stream 分支”与“共享 reporter”之间：stream 分支只看 subtype，不看 errors；
  // reporter 把 errors 非空视为 failed（下一条用例锁定）。不要把这个标题读成新旧回归。
  // C4 结论（2026-10-16 ownership 会话）：保留现状，不统一。两个判据服务不同出口——
  // 用户可见/会话记录用 `normalizeAgentEndReason`（subtype 决定，不看 errors），
  // 程序化 `onRunOutcome` 用 reporter（errors 非空视为 failed）；统一任一侧都会改变产品行为。
  // 精确差异与影响面见同目录下的 C4 记录用例与交付报告 `c4-subtype-success-errors.md`。
  test('subtype=success 但 result.errors 非空：新旧两条执行链都判 completed，与共享 reporter 口径仍有分歧（差异点）', async () => {
    const oldRun = await driveOld(async function* () { yield sdk({ type: 'result', subtype: 'success', errors: ['partial failure'] }) })
    const newRun = await driveNew(async function* () { yield sdk({ type: 'result', subtype: 'success', errors: ['partial failure'] }) })
    // 新路径 stream 分支只看 subtype，不看 errors（errors 仅由 reporter 判定，而 stream 分支不经过它）。
    // 两侧 stream 判定一致；差异属于 stream 分支 vs reporter 分支，不是新旧路径之间。
    expect(newRun.observation.outcome).toEqual({ status: 'completed' })
    expect(oldRun.observation.completions[0]?.endReason).not.toBe('error')
    expect(oldRun.observation.completions[0]?.endReason).toBe('completed')
  })

  test('终态判定单元语义：共享 reporter 把 errors + subtype=success 视为失败（该判据只服务显式喂入 completion signal 的调用方）', () => {
    // 说明（2026-10-16 ownership 会话修正口径）：coordinator 的终态路径不向 reporter 喂
    // `resultSubtype/resultErrors`（只在 stop 时喂 stoppedByUser），因此这条判据在新链
    // 只由“显式喂入 completion signal”的调用方使用（旧链 agent-run-outcome 同判据）。
    const reporter = createAgentRunOutcomeReporter()
    reporter.onComplete({ resultSubtype: 'success', resultErrors: ['partial failure'] })
    expect(reporter.finish()).toEqual({ status: 'failed', error: 'partial failure' })
    const stopped = createAgentRunOutcomeReporter()
    stopped.onComplete({ stoppedByUser: true, resultSubtype: 'error_during_execution', resultErrors: ['boom'] })
    expect(stopped.finish()).toEqual({ status: 'stopped' })
  })

  test('C4 记录：success + errors 非空时，“用户可见终态”与“程序化 onRunOutcome”在同一条链内不同判据（保留现状）', async () => {
    const [{ normalizeAgentEndReason }, { createAgentRunOutcomeReporter: createElectronReporter }] = await Promise.all([
      import('../agent-end-reason'),
      import('../agent-run-outcome'),
    ])

    // 1) 用户可见/会话记录：由 subtype 决定结束原因，errors 不参与。
    expect(normalizeAgentEndReason({ resultSubtype: 'success' }).reason).toBe('completed')
    expect(normalizeAgentEndReason({ resultSubtype: 'success' }).label).toBe('')

    // 2) 程序化：同一输入被 reporter 判为 failed（malformedSuccess）。
    const outcomes: Array<{ status: string; error?: string }> = []
    const electronReporter = createElectronReporter(outcome => outcomes.push(outcome))
    electronReporter.onComplete({ resultSubtype: 'success', resultErrors: ['partial failure'] })
    electronReporter.finish()
    expect(outcomes).toEqual([{ status: 'failed', error: 'partial failure' }])

    // 3) 桌面 IPC 入口不传 onRunOutcome：程序化判据在该入口没有观察者，用户看到的就是 completed。
    const ipcSource = readMainSource('../ipc.ts')
    const sendMessageSlice = ipcSource.slice(
      ipcSource.indexOf('AGENT_IPC_CHANNELS.SEND_MESSAGE'),
      ipcSource.indexOf('AGENT_IPC_CHANNELS.SEND_MESSAGE') + 1200,
    )
    expect(sendMessageSlice).toContain('coordinateAgentSend(')
    expect(sendMessageSlice).not.toContain('onRunOutcome')

    // 4) 新链 stream 分支与“用户可见”判据一致：只看 subtype。
    const newRun = await driveNew(async function* () { yield sdk({ type: 'result', subtype: 'success', errors: ['partial failure'] }) })
    expect(newRun.observation.outcome).toEqual({ status: 'completed' })
    expect(newRun.observation.errors).toEqual([])
  })
})

describe('backgroundTasksPending 与终态', () => {
  test('共享 reporter：backgroundTasksPending 信号不构成终态', () => {
    const reporter = createAgentRunOutcomeReporter()
    reporter.onComplete({ backgroundTasksPending: true })
    // 尚未 finish 时不能给出终态；finish 时必须给 failure（未产生终态）。
    expect(reporter.finish()).toEqual({ status: 'failed', error: 'Agent 未产生运行终态' })
  })

  test('旧路径通过 idleComplete 保留 owner 并携带 backgroundTasksPending（源码证据 + 接缝声明）', () => {
    const source = readMainSource('agent-orchestrator.ts')
    expect(source).toContain('backgroundTasksPending: true')
    expect(source).toContain('const idleComplete = (')
    // 无法在离线 fixture 复现：需要 Electron 侧后台任务端口（piBackgroundTaskManager）与
    // adapter 的 task_started 事件。记录为接缝需求见 failures.md（SEAM-BACKGROUND-TASKS）。
    expect(source).toContain('awaitingBackgroundWake')
  })
})

describe('事件顺序', () => {
  test('消息事件先于终态事件：两侧都满足"每条 provider 消息先投影，再给终态"', async () => {
    const oldRun = await driveOld(async function* () { yield assistant(); yield sdk({ type: 'result', subtype: 'success' }) })
    const oldEventKinds = oldRun.host.events.eventPort.map(payload => payload.kind)
    expect(oldEventKinds.filter(kind => kind === 'sdk_message')).toHaveLength(2)
    expect(oldEventKinds.at(-1)).toBe('profer_event')

    const newRun = await driveNew(async function* () { yield assistant(); yield sdk({ type: 'result', subtype: 'success' }) })
    const newEventTypes = newRun.host.events.runtime.map(event => event.type)
    expect(newEventTypes.filter(type => type === 'message')).toHaveLength(2)
    // claim → 真正启动 → 消息 → 终态（claim 与 provider 启动已分开）。
    expect(newEventTypes[0]).toBe('runtime_claimed')
    expect(newEventTypes[1]).toBe('runtime_started')
    expect(newEventTypes.at(-1)).toBe('runtime_finished')
  })
})
