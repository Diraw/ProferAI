/**
 * 共享执行权（run ownership）行为契约。
 *
 * 覆盖：原子取得、token 校验释放、旧 token 清理、嵌套取得（同一请求不重复 claim）、
 * 拒绝原因结构、具名错误映射，以及用真实 coordinator 做的**双向竞争**验证。
 */

import { describe, expect, test } from 'bun:test'
import { AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError } from '@profer/shared'
import { AgentRuntimeCoordinator } from './coordinator'
import type { AgentRunOutcome } from './events'
import {
  AgentRunOwnershipRegistry,
  createAgentRunOwnershipRegistry,
  createAgentRunOwnershipView,
  createAgentRunRejectionError,
  isAgentRunClaimFailure,
  peekAgentRunClaimFailure,
} from './run-ownership'

const SESSION = 'ownership-session'

describe('claim / release 语义', () => {
  test('Given 无 owner When claim Then 取得成功并登记 runtime/token', () => {
    const registry = createAgentRunOwnershipRegistry({ now: () => 42 })
    const claim = registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-a' })
    expect(claim.ok).toBe(true)
    expect(claim.ok && claim.adopted).toBe(false)
    expect(registry.getOwner(SESSION)).toEqual({ sessionId: SESSION, runtime: 'pi', token: 'run-a', claimedAt: 42 })
    expect(registry.isOwned(SESSION)).toBe(true)
    expect(registry.ownerCount()).toBe(1)
  })

  test('Given 同内核已有 owner When 第二个请求 claim Then 拒绝为 already_active 且不改 owner', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-a' })
    const second = registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-b' })
    expect(second).toMatchObject({ ok: false, reason: 'already_active' })
    expect(isAgentRunClaimFailure(second) && second.owner.token).toBe('run-a')
    expect(registry.getOwner(SESSION)?.token).toBe('run-a')
  })

  test('Given 已绑定另一内核的 owner When claim Then 拒绝为 runtime_mismatch 并给出两侧内核', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: SESSION, runtime: 'claude', token: 'run-a' })
    const second = registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-b' })
    expect(second).toMatchObject({ ok: false, reason: 'runtime_mismatch', expected: 'claude', received: 'pi' })
    expect(registry.getOwner(SESSION)?.runtime).toBe('claude')
  })

  test('Given 非 owner token When release Then 拒绝释放并保留 owner（旧 token 清理）', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-a' })
    expect(registry.release(SESSION, 'run-b')).toBe(false)
    expect(registry.getOwner(SESSION)?.token).toBe('run-a')
    expect(registry.release(SESSION, 'run-a')).toBe(true)
    expect(registry.isOwned(SESSION)).toBe(false)
    // 重复释放不是错误，但必须是 no-op。
    expect(registry.release(SESSION, 'run-a')).toBe(false)
  })

  test('Given 新 run 已接管 When 旧 run finally 释放 Then 不会清掉新 owner', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-old' })
    // 旧 run 被接管（宿主显式释放后新 run 取得）。
    expect(registry.release(SESSION, 'run-old')).toBe(true)
    registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-new' })
    expect(registry.release(SESSION, 'run-old')).toBe(false)
    expect(registry.getOwner(SESSION)?.token).toBe('run-new')
  })

  test('Given 同一 token 再次 claim When 嵌套入口取得 Then 幂等接管，不重复占用', () => {
    const registry = new AgentRunOwnershipRegistry()
    const outer = registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'entry-token' })
    const nested = registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'entry-token' })
    expect(outer.ok && outer.adopted).toBe(false)
    expect(nested.ok && nested.adopted).toBe(true)
    expect(registry.ownerCount()).toBe(1)
    // 嵌套取得后，同一 token 的释放仍然有效（执行权属于这一个请求）。
    expect(registry.release(SESSION, 'entry-token')).toBe(true)
  })

  test('Given 同一 tick 两个请求 When 同时 claim Then 只有一个取得（无 TOCTOU 窗口）', () => {
    const registry = new AgentRunOwnershipRegistry()
    const results = ['run-a', 'run-b'].map(token => registry.claim({ sessionId: SESSION, runtime: 'pi', token }))
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok && result.reason === 'already_active')).toHaveLength(1)
  })

  test('Given 无 owner When 预检 Then 返回 undefined（不占用）', () => {
    const registry = new AgentRunOwnershipRegistry()
    expect(peekAgentRunClaimFailure(registry, SESSION, 'pi')).toBeUndefined()
    expect(registry.ownerCount()).toBe(0)
  })

  test('Given 已有 owner When 预检 Then 返回与 claim 同形的拒绝结构且不改登记表', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: SESSION, runtime: 'claude', token: 'run-a' })
    expect(peekAgentRunClaimFailure(registry, SESSION, 'claude')).toMatchObject({ ok: false, reason: 'already_active' })
    expect(peekAgentRunClaimFailure(registry, SESSION, 'pi')).toMatchObject({ ok: false, reason: 'runtime_mismatch', expected: 'claude', received: 'pi' })
    expect(registry.getOwner(SESSION)?.token).toBe('run-a')
  })

  test('Given releaseAll When 宿主退出 Then 登记表清空', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: 'a', runtime: 'pi' })
    registry.claim({ sessionId: 'b', runtime: 'claude' })
    expect(registry.ownerCount()).toBe(2)
    registry.releaseAll()
    expect(registry.ownerCount()).toBe(0)
  })

  test('Given 共享登记表 When 旧引擎用只读视图读取 Then 看到的就是同一份 owner（无第二张表）', () => {
    const registry = new AgentRunOwnershipRegistry()
    const view = createAgentRunOwnershipView(registry)
    expect(view.get(SESSION)).toBeUndefined()
    expect(view.has(SESSION)).toBe(false)

    registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-generation-1' })
    expect(view.get(SESSION)).toBe('run-generation-1')
    expect(view.has(SESSION)).toBe(true)
    expect(view.keys()).toEqual([SESSION])
    expect(view.size).toBe(1)

    // 视图不能写入：释放仍必须走 registry 的 token 校验。
    expect(registry.release(SESSION, 'run-generation-2')).toBe(false)
    expect(view.has(SESSION)).toBe(true)
    expect(registry.release(SESSION, 'run-generation-1')).toBe(true)
    expect(view.has(SESSION)).toBe(false)
    expect(view.size).toBe(0)
  })
})

describe('拒绝原因 → 具名错误映射', () => {
  test('already_active 映射为 AgentRunAlreadyActiveError，且 stopping 影响文案', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-a' })
    const failure = registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-b' })
    if (failure.ok) throw new Error('fixture 期望拒绝')

    const active = createAgentRunRejectionError(failure)
    expect(active).toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(active.name).toBe('AgentRunAlreadyActiveError')
    expect((active as AgentRunAlreadyActiveError).code).toBe('AGENT_RUN_ALREADY_ACTIVE')
    expect((active as AgentRunAlreadyActiveError).stopping).toBe(false)
    expect(active.message).toContain('上一条消息仍在处理中')

    const stopping = createAgentRunRejectionError(failure, { stopping: true })
    expect((stopping as AgentRunAlreadyActiveError).stopping).toBe(true)
    expect(stopping.message).toContain('Agent 正在停止')
  })

  test('runtime_mismatch 映射为 AgentSessionRuntimeMismatchError', () => {
    const registry = new AgentRunOwnershipRegistry()
    registry.claim({ sessionId: SESSION, runtime: 'claude', token: 'run-a' })
    const failure = registry.claim({ sessionId: SESSION, runtime: 'pi', token: 'run-b' })
    if (failure.ok) throw new Error('fixture 期望拒绝')
    const error = createAgentRunRejectionError(failure)
    expect(error).toBeInstanceOf(AgentSessionRuntimeMismatchError)
    expect(error.name).toBe('AgentSessionRuntimeMismatchError')
    expect(error.message).toContain('AGENT_SESSION_RUNTIME_MISMATCH')
  })
})

describe('双向竞争：共享登记表下的跨引擎互斥', () => {
  const streamOnce = () => (async function* stream() {
    yield { type: 'result', subtype: 'success' } as never
  })()

  interface EngineProbe {
    coordinator: AgentRuntimeCoordinator
    state: { starts: number; stops: number }
    /** 发起一次可被手动结束的挂起 run。 */
    start(): { outcome: Promise<AgentRunOutcome>; release(): void }
  }

  /** 用同一个登记表构建一个“引擎”（真实 coordinator + 可控 provider）。 */
  function createProbe(ownership: AgentRunOwnershipRegistry): EngineProbe {
    const state = { starts: 0, stops: 0 }
    let currentGate: Promise<void> = Promise.resolve()
    const coordinator = new AgentRuntimeCoordinator({
      ownership,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => { state.starts += 1; return streamOnce() },
          query: async () => { state.starts += 1; await currentGate; return { status: 'completed' } },
          stop: async () => { state.stops += 1 },
        },
      },
    })
    return {
      coordinator,
      state,
      start() {
        let release!: () => void
        currentGate = new Promise<void>(resolve => { release = resolve })
        const outcome = coordinator.run({ sessionId: SESSION, runtime: 'pi', prompt: 'probe' }).promise
        return { outcome, release }
      },
    }
  }

  test('Given 一个共享登记表 When 两侧交替持有 Then 另一侧一定被拒绝且不启动 provider', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    const engineA = createProbe(ownership)
    const engineB = createProbe(ownership)

    // 方向 1：A 持有 → B 被拒绝。
    const runA = engineA.start()
    expect(engineA.coordinator.isRunning(SESSION)).toBe(true)
    const rejectedB = engineB.coordinator.run({ sessionId: SESSION, runtime: 'pi', prompt: 'b' })
    await expect(rejectedB.promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(engineB.state.starts).toBe(0)
    expect(engineB.coordinator.isRunning(SESSION)).toBe(false)
    // 被拒绝的 handle.stop 不能清理仍在运行的 owner。
    await rejectedB.stop()
    expect(engineA.coordinator.isRunning(SESSION)).toBe(true)
    expect(engineA.state.stops).toBe(0)
    runA.release()
    await expect(runA.outcome).resolves.toEqual({ status: 'completed' })
    expect(ownership.isOwned(SESSION)).toBe(false)

    // 方向 2：B 持有 → A 被拒绝。
    const runB = engineB.start()
    const rejectedA = engineA.coordinator.run({ sessionId: SESSION, runtime: 'pi', prompt: 'a' })
    await expect(rejectedA.promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(engineA.state.starts).toBe(1)
    runB.release()
    await expect(runB.outcome).resolves.toEqual({ status: 'completed' })
    expect(ownership.isOwned(SESSION)).toBe(false)
  })

  test('Given 旧引擎风格的字符串 token 持有 When runtime 请求同 session Then 被拒绝（token 类型无关）', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    // 旧引擎（宿主接线后）用自己的 runGeneration 字符串取得执行权。
    const legacy = ownership.claim({ sessionId: SESSION, runtime: 'pi', token: 'legacy-run-generation' })
    expect(legacy.ok).toBe(true)

    let starts = 0
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', stream: () => { starts += 1; return streamOnce() }, query: async () => ({ status: 'completed' }) } },
      ownership,
    })
    await expect(coordinator.run({ sessionId: SESSION, runtime: 'pi', prompt: 'p' }).promise)
      .rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    expect(starts).toBe(0)
    // 旧引擎的 owner 没有被新引擎的拒绝路径清掉。
    expect(ownership.getOwner(SESSION)?.token).toBe('legacy-run-generation')
  })

  test('Given 未注入共享登记表 When 两个 coordinator 并存 Then 只在本协调器内互斥（默认行为）', async () => {
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => { releaseA = resolve })
    let holdingStarts = 0
    let otherStarts = 0
    const holdingA = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', query: async () => { holdingStarts += 1; await gate; return { status: 'completed' } } } },
    })
    const other = new AgentRuntimeCoordinator({
      adapters: { pi: { runtime: 'pi', stream: () => { otherStarts += 1; return streamOnce() }, query: async () => ({ status: 'completed' }) } },
    })
    const runA = holdingA.run({ sessionId: SESSION, runtime: 'pi', prompt: 'a' })
    // 各自独立的默认登记表：B 看不到 A 的 owner（跨引擎互斥需要宿主注入同一个实例）。
    const outcome = await other.run({ sessionId: SESSION, runtime: 'pi', prompt: 'b' }).promise
    expect(outcome).toEqual({ status: 'completed' })
    expect(otherStarts).toBe(1)
    releaseA()
    await runA.promise
    expect(holdingA.ownership.ownerCount()).toBe(0)
    expect(holdingStarts).toBe(1)
  })
})
