/**
 * runtime-migration-parity / 共享 ownership 对照（重点 2）
 *
 * 覆盖：
 * 1. 同 session 并发请求的拒绝语义；
 * 2. runtime mismatch 是否在副作用（消息持久化 / provider 启动）之前被拒绝；
 * 3. 失败或停止后 owner 是否释放、能否再次运行；
 * 4. 旧 run 的清理是否会误释放新 run 的 owner（owner token）。
 *
 * 两侧由同一份内存宿主（`createParityHost`）驱动：旧 = 真实 AgentOrchestrator（切片编译），
 * 新 = 真实 AgentRuntimeCoordinator。差异不以"旧路径一定正确"为前提，见每条断言注释。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AgentSessionMeta, SDKMessage } from '@profer/shared'
import { AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError } from '@profer/shared'
import { AgentRuntimeCoordinator, createAgentRunOwnershipRegistry } from '@profer/agent-runtime'
import {
  AgentRunAlreadyActiveError as GuardedAgentRunAlreadyActiveError,
  releaseActiveSession,
  tryAcquireActiveSession,
} from '../agent-orchestrator-p0-guards'
import { createNewEngine } from './support/new-engine'
import { createOldEngine } from './support/old-engine'
import { createParityHost } from './support/parity-host'

const meta = (runtime: 'claude' | 'pi', extra: Partial<AgentSessionMeta> = {}): AgentSessionMeta => ({
  id: 'parity-session', title: 'fixture', agentRuntime: runtime, createdAt: 1, updatedAt: 1, ...extra,
})

const successStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null } as unknown as SDKMessage
  yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
})()

function input(runtime: 'claude' | 'pi' = 'pi') {
  return { sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: runtime }
}

describe('并发拒绝（同 session 第二个请求）', () => {
  test('两侧都拒绝第二次请求，且 provider 只启动一次、不产生第二个终态', async () => {
    const oldHost = createParityHost({ runtime: 'pi', meta: meta('pi'), credentials: 'pending' })
    const old = createOldEngine({ host: oldHost, input: input(), adapter: { query: successStream } })
    const oldFirst = old.run()
    const oldSecond = await old.run()
    expect(oldSecond.threw).toContain('AGENT_RUN_ALREADY_ACTIVE')
    expect(oldSecond.runOwned).toBe(0)
    expect(oldSecond.completions).toEqual([])
    expect(oldSecond.providerStarts).toBe(0)
    expect(oldHost.events.legacy).toEqual([])
    oldHost.resolveCredentials()
    await oldFirst

    const newHost = createParityHost({ runtime: 'pi', meta: meta('pi'), credentials: 'pending' })
    const newEngine = createNewEngine({ host: newHost, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const first = newEngine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    const second = await newEngine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(second.providerStarts).toBe(0)
    expect(second.runStarted).toBe(0)
    expect(second.outcomes).toEqual([])
    // 与旧路径同义：拒绝是可被入口识别的具名错误（不再 resolve 成 failed outcome），
    // 调用方不需要字符串比较，也不会把拒绝当成一次运行终态。
    expect(second.rejected).toContain('AgentRunAlreadyActiveError')
    expect(second.rejected).toContain('AGENT_RUN_ALREADY_ACTIVE')
    expect(second.outcome).toBeUndefined()
    // 拒绝请求不产生任何持久化副作用，也不能清理仍在运行的 owner。
    expect(newHost.session.appendCalls).toEqual([])
    // 唯一一次内核绑定来自第一个 run；第二个请求在 claim 阶段就被拒绝，未触碰 SessionPort。
    expect(newHost.session.lockAttempts).toEqual([{ sessionId: 'parity-session', runtime: 'pi', accepted: true }])
    // 第一个 run 仍在准备阶段（凭证 pending）：只能看到 claim，不得宣告运行已开始。
    expect(newHost.events.runtime.map(event => event.type)).toEqual(['runtime_claimed'])
    expect(second.activeAfter).toBe(true)
    newHost.resolveCredentials()
    await first.observation
  })

  test('【切换门槛】新路径的拒绝应可被入口识别为具名错误（已修复：抛出 AgentRunAlreadyActiveError）', async () => {
    const host = createParityHost({ runtime: 'pi', meta: meta('pi'), credentials: 'pending' })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const first = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    let thrown: unknown
    try {
      // 真实 Electron 包装层 runAgentRuntimeHeadless 的旧实现把拒绝压成 failed outcome；
      // coordinator 侧现在直接抛 AgentRunAlreadyActiveError（与旧路径同义的具名错误）。
      await engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' }).handle.promise
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentRunAlreadyActiveError)
    expect((thrown as AgentRunAlreadyActiveError).name).toBe('AgentRunAlreadyActiveError')
    expect((thrown as AgentRunAlreadyActiveError).code).toBe('AGENT_RUN_ALREADY_ACTIVE')
    // 拒绝的稳定结构来自 registry 的 claim 结果，不是字符串匹配。
    expect(engine.coordinator.ownership.getOwner('parity-session')).toBeDefined()
    host.resolveCredentials()
    await first.observation
  })

  test('拒绝错误类型在 shared 与宿主守卫之间是同一个类（不用字符串判断）', () => {
    // 旧路径的守卫文件只做转发；否则 runtime 抛出的错误无法被入口 `instanceof` 识别。
    expect(GuardedAgentRunAlreadyActiveError).toBe(AgentRunAlreadyActiveError)
  })
})

describe('runtime mismatch 在副作用之前拒绝', () => {
  test('旧路径：会话已绑定 claude、请求 pi → 抛 mismatch，无锁写入、无持久化、无 provider', async () => {
    const host = createParityHost({ runtime: 'claude', meta: meta('claude') })
    const old = createOldEngine({ host, input: input('pi') })
    const observation = await old.run()
    expect(observation.threw).toContain('AGENT_SESSION_RUNTIME_MISMATCH')
    expect(observation.runOwned).toBe(0)
    expect(observation.providerStarts).toBe(0)
    expect(host.session.lockAttempts).toEqual([])
    expect(host.session.appendCalls).toEqual([])
    expect(host.events.legacy).toEqual([])
    expect(old.instance.isActive('parity-session')).toBe(false)
  })

  test('新路径（SessionPort 提供 lockRuntime）：同样在副作用之前拒绝', async () => {
    const host = createParityHost({ runtime: 'claude', meta: meta('claude') })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const observation = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel', runtime: 'pi' })
    expect(observation.rejected).toContain('AGENT_SESSION_RUNTIME_MISMATCH')
    expect(observation.providerStarts).toBe(0)
    expect(host.session.appendCalls).toEqual([])
    expect(host.session.lockAttempts).toEqual([{ sessionId: 'parity-session', runtime: 'pi', accepted: false }])
    expect(observation.activeAfter).toBe(false)
    expect(host.events.runtime.map(event => event.type)).toEqual([])
  })

  test('【切换门槛】SessionPort 未提供可选的 lockRuntime 时，新路径也拒绝 mismatch（已修复）', async () => {
    const host = createParityHost({ runtime: 'claude', meta: meta('claude'), provideLockRuntime: false })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const observation = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel', runtime: 'pi' })
    // 旧路径在编排层显式比较 input.agentRuntime 与 boundSession.agentRuntime，不依赖端口方法；
    // 新路径现在在 coordinator 内用同一判据（会话元数据）拒绝，不依赖可选端口。
    expect(observation.rejected).toContain('AGENT_SESSION_RUNTIME_MISMATCH')
    expect(observation.providerStarts).toBe(0)
    expect(host.session.appendCalls).toEqual([])
    expect(host.session.lockAttempts).toEqual([])
    expect(host.events.runtime).toEqual([])
    expect(observation.activeAfter).toBe(false)
  })

  test('现状记录（已修复）：端口缺席时 mismatch 不再被静默执行', async () => {
    const host = createParityHost({ runtime: 'claude', meta: meta('claude'), provideLockRuntime: false })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const observation = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel', runtime: 'pi' })
    // 修复前：outcome = completed、provider 启动 1 次、会话元数据仍为 claude（跨内核污染）。
    // 修复后：mismatch 在 provider / 落盘 / 事件之前被拒绝，且不留下 owner。
    expect(observation.outcome).toBeUndefined()
    expect(observation.rejected).toContain('AgentSessionRuntimeMismatchError')
    expect(observation.providerStarts).toBe(0)
    expect(host.session.meta?.agentRuntime).toBe('claude')
    expect(engine.coordinator.ownership.ownerCount()).toBe(0)
  })

  test('mismatch 拒绝发生在 provider 之前的证据：适配器未被调用且会话元数据未被改写', async () => {
    const host = createParityHost({ runtime: 'claude', meta: meta('claude') })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: successStream }, claude: { runtime: 'claude', stream: successStream } } })
    await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel', runtime: 'pi' })
    expect(engine.recording.providerStarts).toBe(0)
    expect(host.session.metaPatches).toEqual([])
    expect(host.session.meta?.agentRuntime).toBe('claude')
  })
})

describe('owner 释放与再次运行', () => {
  test('凭证失败后两侧都释放 owner 并允许同一 session 重新运行', async () => {
    const oldHost = createParityHost({ runtime: 'pi', meta: meta('pi'), credentials: { ok: false, code: 'token_expired' } })
    const old = createOldEngine({ host: oldHost, input: input() })
    const oldFirst = await old.run()
    expect(oldFirst.activeAfter).toBe(false)
    expect(oldFirst.providerStarts).toBe(0)

    const newHost = createParityHost({ runtime: 'pi', meta: meta('pi'), credentials: { ok: false, code: 'token_expired' } })
    const engine = createNewEngine({ host: newHost, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const first = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(first.activeAfter).toBe(false)
    expect(first.providerStarts).toBe(0)
    expect(first.outcome).toEqual({ status: 'failed', error: 'Credential resolution failed: token_expired' })
  })

  test('内核绑定写盘失败：两侧都不启动 provider，且不泄漏 owner', async () => {
    const oldHost = createParityHost({ runtime: 'pi', meta: meta('pi', { agentRuntimeLocked: false }), lockRuntimeFailure: 'storage' })
    const old = createOldEngine({ host: oldHost, input: input() })
    const oldObservation = await old.run()
    expect(oldObservation.providerStarts).toBe(0)
    expect(oldObservation.activeAfter).toBe(false)
    expect(oldHost.session.appendCalls).toEqual([])

    const newHost = createParityHost({ runtime: 'pi', meta: meta('pi', { agentRuntimeLocked: false }), lockRuntimeFailure: 'storage' })
    const engine = createNewEngine({ host: newHost, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const newObservation = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(newObservation.providerStarts).toBe(0)
    expect(newObservation.activeAfter).toBe(false)
    expect(newObservation.rejected).toContain('lock write failed')
    expect(newHost.session.appendCalls).toEqual([])
  })

  test('运行中终止后 owner 释放，provider 停止只调用一次（两侧一致）', async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    const oldHost = createParityHost({ runtime: 'pi', meta: meta('pi') })
    const old = createOldEngine({
      host: oldHost,
      input: input(),
      adapter: {
        query: () => (async function* stream(): AsyncGenerator<SDKMessage> {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] }, parent_tool_use_id: null } as unknown as SDKMessage
          await oldGate
          yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
        })(),
      },
    })
    const oldRunning = old.run()
    await waitFor(() => old.recording.providerStarts === 1)
    old.instance.stop('parity-session')
    releaseOld()
    const oldObservation = await oldRunning
    expect(oldObservation.completions[0]?.stoppedByUser).toBe(true)
    expect(oldObservation.activeAfter).toBe(false)
    expect(old.recording.abortCalls).toEqual(['parity-session'])

    let releaseNew!: () => void
    const newGate = new Promise<void>(resolve => { releaseNew = resolve })
    const newHost = createParityHost({ runtime: 'pi', meta: meta('pi') })
    const engine = createNewEngine({
      host: newHost,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] }, parent_tool_use_id: null } as unknown as SDKMessage
            await newGate
            yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
          })(),
          stop: async () => { releaseNew() },
        },
      },
    })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await waitFor(() => engine.recording.providerStarts === 1)
    await running.handle.stop()
    releaseNew()
    const newObservation = await running.observation
    expect(newObservation.outcome).toEqual({ status: 'stopped' })
    expect(newObservation.activeAfter).toBe(false)
    expect(engine.recording.providerStops).toBe(1)
  })

  test('owner token 语义：只有持有当前 token 的运行能释放会话（旧守卫真实实现）', () => {
    const active = new Map<string, string>()
    expect(tryAcquireActiveSession(active, 'session', 'run-a')).toBe(true)
    expect(tryAcquireActiveSession(active, 'session', 'run-b')).toBe(false)
    // 旧 run 的 finally 不能释放已经被新 run 接管的会话。
    expect(releaseActiveSession(active, 'session', 'run-b')).toBe(false)
    expect(active.get('session')).toBe('run-a')
    expect(releaseActiveSession(active, 'session', 'run-a')).toBe(true)
    expect(active.has('session')).toBe(false)
  })

  test('新路径用 symbol token 持有 owner，释放前校验 token（源码证据）', () => {
    const source = readMainSourceOfCoordinator()
    expect(source).toContain('if (this.active.get(input.sessionId)?.token === token) this.active.delete(input.sessionId)')
    expect(source).toContain('if (finished || this.active.get(input.sessionId)?.token !== token || controller.signal.aborted) return')
    // 执行权归共享登记表：claim 在任何 await 之前，release 校验 token。
    expect(source).toContain('const claim = this.ownership.claim({ sessionId: input.sessionId, runtime: input.runtime, token })')
    expect(source).toContain('this.ownership.release(input.sessionId, token)')
  })

  test('跨引擎互斥已接线：两侧共用同一张登记表，入口不再各自读自己的 map（已修复）', () => {
    const agentService = readFileSync(coordinatorRelativePath('agent-service.ts'), 'utf8')
    // 修复前：新入口只读两侧 map 做预检，桌面入口完全不看新引擎（TOCTOU + 伪终态）。
    // 修复后：单一登记表注入两条链；入口预检已删除，互斥由 claim 保证。
    expect(agentService).toContain('const runOwnership = createAgentRunOwnershipRegistry()')
    expect(agentService).toContain('}, runOwnership)')
    expect(agentService).toContain('ownership: runOwnership,')
    expect(agentService).not.toContain('Agent session is already running')
    const runtimeEntrySlice = agentService.slice(
      agentService.indexOf('export async function runAgentRuntimeHeadless('),
      agentService.indexOf('export async function stopAgentRuntime('),
    )
    expect(runtimeEntrySlice).not.toContain('orchestrator.isActive(input.sessionId)')
    expect(runtimeEntrySlice).toContain('runRuntimeHeadlessEntry(input, runtimeCallbacks')
    // 桌面入口：runAgent 切片内没有对 runtime coordinator 的**预检查询**（互斥在共享登记表里，
    // 不在入口）。开启桌面 runtime 链时由共享入口经 coordinator 的 claim 取执行权，不做 TOCTOU 预检。
    const runAgentSlice = agentService.slice(agentService.indexOf('export async function runAgent('), agentService.indexOf('/**\n * 直接使用 runtime coordinator 的 headless 入口'))
    expect(runAgentSlice).not.toContain('runtimeCoordinator.isRunning(')
    // 旧引擎不再持有第二张 owner 表：activeSessions 是共享登记表的只读视图。
    const orchestratorSource = readFileSync(coordinatorRelativePath('agent-orchestrator.ts'), 'utf8')
    expect(orchestratorSource).not.toContain('private activeSessions = new Map<string, string>()')
    expect(orchestratorSource).toContain('createAgentRunOwnershipView(ownership)')
    expect(orchestratorSource).toContain('this.ownership.claim({ sessionId, runtime: agentRuntime, token: runGeneration })')
    expect(orchestratorSource).toContain('this.ownership.release(sessionId, runGeneration)')
  })

  test('双向互斥：新引擎持有 session 时旧引擎（真实编排器 + 同一登记表）被拒绝，不启动 provider', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    // 新引擎（真实 coordinator）先持有。
    expect(ownership.claim({ sessionId: 'parity-session', runtime: 'pi', token: Symbol('runtime-run') }).ok).toBe(true)
    const host = createParityHost({ runtime: 'pi', meta: meta('pi') })
    const old = createOldEngine({ host, input: input(), adapter: { query: successStream }, ownership })
    const observation = await old.run()
    expect(observation.threw).toContain('AGENT_RUN_ALREADY_ACTIVE')
    expect(observation.runOwned).toBe(0)
    expect(observation.providerStarts).toBe(0)
    expect(host.session.appendCalls).toEqual([])
    // 新引擎的 owner 没有被旧引擎的拒绝路径清掉。
    expect(ownership.getOwner('parity-session')?.runtime).toBe('pi')
  })

  test('双向互斥：旧引擎持有 session 时桌面入口使用的共享登记表已占用（同一判据）', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    const host = createParityHost({ runtime: 'pi', meta: meta('pi'), credentials: 'pending' })
    const old = createOldEngine({ host, input: input(), adapter: { query: successStream }, ownership })
    const running = old.run()
    // 旧引擎已在任何 await 之前取得执行权（同一张表）。
    expect(ownership.getOwner('parity-session')).toBeDefined()
    // 新引擎（同一登记表）被拒绝，且不产生任何副作用。
    const newHost = createParityHost({ runtime: 'pi', meta: meta('pi') })
    let providerStarts = 0
    const coordinator = new AgentRuntimeCoordinator({
      ownership,
      ports: newHost.ports,
      adapters: { pi: { runtime: 'pi', stream: () => { providerStarts += 1; return successStream() }, query: async () => ({ status: 'completed' }) } },
    })
    await expect(coordinator.run({ sessionId: 'parity-session', runtime: 'pi', prompt: 'hello' }).promise)
      .rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(providerStarts).toBe(0)
    expect(newHost.session.appendCalls).toEqual([])
    host.resolveCredentials()
    await running
  })
})

describe('共享执行权登记表（跨引擎互斥的接线契约）', () => {
  test('旧引擎风格的字符串 token 持有 session 时，新引擎被拒绝且不启动 provider', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    // 旧引擎（宿主接线后）用自己的 runGeneration 字符串取得执行权。
    expect(ownership.claim({ sessionId: 'parity-session', runtime: 'pi', token: 'legacy-run-generation' }).ok).toBe(true)
    const host = createParityHost({ runtime: 'pi', meta: meta('pi') })
    let providerStarts = 0
    const coordinator = new AgentRuntimeCoordinator({
      ownership,
      ports: host.ports,
      adapters: { pi: { runtime: 'pi', stream: () => { providerStarts += 1; return successStream() }, query: async () => ({ status: 'completed' }) } },
    })
    await expect(coordinator.run({ sessionId: 'parity-session', runtime: 'pi', prompt: 'hello' }).promise)
      .rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(providerStarts).toBe(0)
    expect(host.session.appendCalls).toEqual([])
    expect(host.events.runtime).toEqual([])
    // 旧引擎的 owner 没有被新引擎的拒绝路径清掉。
    expect(ownership.getOwner('parity-session')?.token).toBe('legacy-run-generation')
  })

  test('嵌套入口：上层已持有 token 时 coordinator 幂等接管（同一请求不重复 claim）', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    expect(ownership.claim({ sessionId: 'parity-session', runtime: 'pi', token: 'entry-run-token' }).ok).toBe(true)
    const host = createParityHost({ runtime: 'pi', meta: meta('pi') })
    const coordinator = new AgentRuntimeCoordinator({
      ownership,
      ports: host.ports,
      adapters: { pi: { runtime: 'pi', stream: successStream, query: async () => ({ status: 'completed' }) } },
    })
    // runAgentHeadless → runtime 入口的真实形态：同一 token 不应被当成并发请求拒绝。
    await expect(coordinator.run({ sessionId: 'parity-session', runtime: 'pi', prompt: 'hello', ownershipToken: 'entry-run-token' }).promise)
      .resolves.toEqual({ status: 'completed' })
    expect(ownership.ownerCount()).toBe(0)
  })

  test('被拒绝请求的 handle.stop 不能清理仍在运行的任务（token 校验释放）', async () => {
    const host = createParityHost({ runtime: 'pi', meta: meta('pi'), credentials: 'pending' })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const first = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    const rejected = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await expect(rejected.handle.promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    await rejected.handle.stop()
    expect(engine.coordinator.isRunning('parity-session')).toBe(true)
    expect(engine.recording.providerStops).toBe(0)
    host.resolveCredentials()
    const observation = await first.observation
    expect(observation.outcome).toEqual({ status: 'failed', error: 'Credential resolution failed: token_expired' })
  })

  test('mismatch 拒绝类型同样是具名错误（不依赖可选端口）', async () => {
    const host = createParityHost({ runtime: 'claude', meta: meta('claude'), provideLockRuntime: false })
    const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: successStream } } })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel', runtime: 'pi' })
    await expect(running.handle.promise).rejects.toBeInstanceOf(AgentSessionRuntimeMismatchError)
    expect((await running.observation).providerStarts).toBe(0)
  })
})

function readMainSourceOfCoordinator(): string {
  return readFileSync(new URL('../../../../../../packages/agent-runtime/src/coordinator.ts', import.meta.url), 'utf8')
}

/** 从本文件位置读取 main/lib 下的文件（`..` 到 lib）。 */
function coordinatorRelativePath(file: string): URL {
  return new URL(`../${file}`, import.meta.url)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
