/**
 * runtime-migration-parity / 取消与终态生命周期对照（重点 3）
 *
 * 覆盖：preparation 期间取消、provider 流消费中取消、重试退避期间取消、stopAndWait 等待语义、
 * 终态一次性（不能出现第二个终态或多发 onError）。
 *
 * 说明：旧侧的 provider 流由真实 `sendMessage` 消费（含真实 `readAgentStreamNext` /
 * `createAgentStreamDrainController` / 重试循环），不是替身实现；新侧用真实 coordinator。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { AgentRunAlreadyActiveError } from '@profer/shared'
import { AgentRuntimeCoordinator, createAgentRunOwnershipRegistry } from '@profer/agent-runtime'
import { createNewEngine } from './support/new-engine'
import { createOldEngine } from './support/old-engine'
import { createParityHost } from './support/parity-host'

const input = () => ({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' as const })

function sdk(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('preparation 期间取消', () => {
  test('凭证解析挂起时取消：两侧都得到 stopped 终态且 provider 从未启动', async () => {
    const oldHost = createParityHost({ runtime: 'pi', credentials: 'pending' })
    const old = createOldEngine({ host: oldHost, input: input() })
    const oldRunning = old.run()
    await waitFor(() => oldHost.credentialCalls.length === 1)
    old.instance.stop('parity-session')
    oldHost.resolveCredentials()
    const oldObservation = await oldRunning
    expect(oldObservation.providerStarts).toBe(0)
    expect(oldObservation.completions).toHaveLength(1)
    expect(oldObservation.completions[0]?.stoppedByUser).toBe(true)
    expect(oldObservation.activeAfter).toBe(false)

    const newHost = createParityHost({ runtime: 'pi', credentials: 'pending' })
    const engine = createNewEngine({ host: newHost, adapters: { pi: { runtime: 'pi', query: async () => ({ status: 'completed' }) } } })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await waitFor(() => newHost.credentialCalls.length === 1)
    await running.handle.stop()
    newHost.resolveCredentials()
    const observation = await running.observation
    expect(observation.providerStarts).toBe(0)
    expect(observation.outcome).toEqual({ status: 'stopped' })
    expect(observation.outcomes).toEqual([{ status: 'stopped' }])
    expect(observation.activeAfter).toBe(false)
  })

  test('准备阶段取消后不启动 provider：两侧都不产生 provider 调用与终态之外的副作用', async () => {
    const newHost = createParityHost({
      runtime: 'pi',
      // 真实 port 契约：preparation 必须响应 signal（`createAgentQueryPreparationPort` 内部
      // 在每个 await 后 `signal.throwIfAborted()`）。这里按同一契约实现，否则测的是
      // 一个永不响应的替身，而不是产品行为。
      queryPreparation: {
        prepare: async (_input, signal) => await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Agent query preparation was stopped', 'AbortError')), { once: true })
        }),
      },
    })
    const engine = createNewEngine({ host: newHost, adapters: { pi: { runtime: 'pi', query: async () => ({ status: 'completed' }) } } })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await new Promise(resolve => setTimeout(resolve, 10))
    await running.handle.stop()
    const observation = await running.observation
    expect(observation.outcome).toEqual({ status: 'stopped' })
    expect(observation.providerStarts).toBe(0)
    // 旧侧同一场景（provider 之前停止）由上面的凭证挂起用例覆盖：`activeAfter=false` + 未启动 provider。
  })
})

describe('provider 流消费期间取消', () => {
  test('流中取消：两侧都 stopped、都调用 provider 停止、且终态只有一个', async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    const oldHost = createParityHost({ runtime: 'pi' })
    const old = createOldEngine({
      host: oldHost,
      input: input(),
      adapter: {
        query: () => (async function* stream(): AsyncGenerator<SDKMessage> {
          yield sdk({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, parent_tool_use_id: null })
          await oldGate
          yield sdk({ type: 'result', subtype: 'success' })
        })(),
      },
    })
    const oldRunning = old.run()
    await waitFor(() => old.recording.providerStarts === 1)
    old.instance.stop('parity-session')
    releaseOld()
    const oldObservation = await oldRunning
    expect(oldObservation.completions).toHaveLength(1)
    expect(oldObservation.completions[0]?.stoppedByUser).toBe(true)
    expect(oldObservation.completions[0]?.endReason).toBe('stopped_by_user')
    expect(old.recording.abortCalls).toHaveLength(1)
    expect(oldObservation.activeAfter).toBe(false)

    let releaseNew!: () => void
    const newGate = new Promise<void>(resolve => { releaseNew = resolve })
    const newHost = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({
      host: newHost,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            yield sdk({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] }, parent_tool_use_id: null })
            await newGate
            yield sdk({ type: 'result', subtype: 'success' })
          })(),
          stop: async () => { releaseNew() },
        },
      },
    })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await waitFor(() => engine.recording.providerStarts === 1)
    await running.handle.stop()
    releaseNew()
    const observation = await running.observation
    expect(observation.outcomes).toEqual([{ status: 'stopped' }])
    expect(observation.errors).toEqual([])
    expect(engine.recording.providerStops).toBe(1)
    expect(observation.activeAfter).toBe(false)
  })

  test('终态一次性：provider 回调重复终态 / 终态后再来消息，两侧都只投影一次', async () => {
    const oldHost = createParityHost({ runtime: 'pi' })
    const old = createOldEngine({
      host: oldHost,
      input: input(),
      adapter: {
        query: () => (async function* stream(): AsyncGenerator<SDKMessage> {
          yield sdk({ type: 'result', subtype: 'success' })
          yield sdk({ type: 'result', subtype: 'success' })
        })(),
      },
    })
    const oldObservation = await old.run()
    expect(oldObservation.completions).toHaveLength(1)

    let savedCallbacks: { onComplete?: (signal: { status: string }) => unknown; onMessage?: (message: SDKMessage) => unknown } | undefined
    const newHost = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({
      host: newHost,
      adapters: {
        pi: {
          runtime: 'pi',
          query: async (_query, callbacks) => {
            savedCallbacks = callbacks as never
            await callbacks.onComplete?.({ status: 'completed' })
            await callbacks.onComplete?.({ status: 'stopped' })
            return { status: 'completed' }
          },
        },
      },
    })
    const observation = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(observation.outcomes).toEqual([{ status: 'completed' }])
    const writesBeforeLateMessage = newHost.session.appendCalls.length
    await savedCallbacks?.onMessage?.(sdk({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null }))
    expect(newHost.session.appendCalls.length).toBe(writesBeforeLateMessage)
  })
})

describe('stopAndWait 等待语义', () => {
  test('stopAndWait 返回时 owner 一定已释放，且已有终态（两侧一致）', async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    const oldHost = createParityHost({ runtime: 'pi' })
    const old = createOldEngine({
      host: oldHost,
      input: input(),
      adapter: {
        query: () => (async function* stream(): AsyncGenerator<SDKMessage> {
          yield sdk({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null })
          await oldGate
          yield sdk({ type: 'result', subtype: 'success' })
        })(),
      },
    })
    const oldRunning = old.run()
    await waitFor(() => old.recording.providerStarts === 1)
    const oldStopping = old.instance.stopAndWait('parity-session')
    releaseOld()
    await oldStopping
    expect(old.instance.isActive('parity-session')).toBe(false)
    const oldObservation = await oldRunning
    expect(oldObservation.completions).toHaveLength(1)

    let releaseNew!: () => void
    const newGate = new Promise<void>(resolve => { releaseNew = resolve })
    const newHost = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({
      host: newHost,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            yield sdk({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null })
            await newGate
            yield sdk({ type: 'result', subtype: 'success' })
          })(),
          stop: async () => { releaseNew() },
        },
      },
    })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await waitFor(() => engine.recording.providerStarts === 1)
    const stopping = engine.coordinator.stopAndWait('parity-session')
    releaseNew()
    await stopping
    expect(engine.coordinator.isRunning('parity-session')).toBe(false)
    const observation = await running.observation
    expect(observation.outcome).toEqual({ status: 'stopped' })
  })
})

describe('重试退避期间取消', () => {
  test('可重试失败后等待退避时取消：两侧都不再重试，provider 只启动一次', async () => {
    let oldAttempts = 0
    const oldHost = createParityHost({ runtime: 'pi' })
    const old = createOldEngine({
      host: oldHost,
      input: input(),
      retryDelayMs: () => 3_000,
      adapter: {
        query: () => {
          oldAttempts += 1
          return (async function* stream(): AsyncGenerator<SDKMessage> {
            throw new Error('503 upstream busy')
          })()
        },
      },
    })
    const oldRunning = old.run()
    await waitFor(() => oldAttempts === 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    old.instance.stop('parity-session')
    const oldObservation = await oldRunning
    expect(oldAttempts).toBe(1)
    expect(oldObservation.completions).toHaveLength(1)
    expect(oldObservation.completions[0]?.stoppedByUser).toBe(true)
    expect(oldObservation.activeAfter).toBe(false)

    let newAttempts = 0
    const newHost = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({
      host: newHost,
      adapters: {
        pi: {
          runtime: 'pi',
          query: async () => {
            newAttempts += 1
            return { status: 'failed', error: '503 upstream busy' }
          },
        },
      },
      retry: { maxRetries: 2, maxWaitMs: 60_000, maxDelayMs: 3_000, random: () => 1 },
    })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await waitFor(() => newAttempts === 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    await running.handle.stop()
    const observation = await running.observation
    expect(newAttempts).toBe(1)
    expect(observation.outcome).toEqual({ status: 'stopped' })
    expect(observation.outcomes).toEqual([{ status: 'stopped' }])
    expect(observation.activeAfter).toBe(false)
  })

  test('对照：不取消时两侧都会重试并在第二次尝试成功（重试语义存在且次数一致）', async () => {
    let oldAttempts = 0
    const oldHost = createParityHost({ runtime: 'pi' })
    const old = createOldEngine({
      host: oldHost,
      input: input(),
      retryDelayMs: () => 1,
      adapter: {
        query: () => {
          oldAttempts += 1
          if (oldAttempts === 1) {
            return (async function* stream(): AsyncGenerator<SDKMessage> {
              throw new Error('503 upstream busy')
            })()
          }
          return (async function* stream(): AsyncGenerator<SDKMessage> {
            yield sdk({ type: 'result', subtype: 'success' })
          })()
        },
      },
    })
    const oldObservation = await old.run()
    expect(oldAttempts).toBe(2)
    expect(oldObservation.completions[0]?.endReason).toBe('completed')

    let newAttempts = 0
    const newHost = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({
      host: newHost,
      adapters: {
        pi: {
          runtime: 'pi',
          query: async () => {
            newAttempts += 1
            return newAttempts === 1 ? { status: 'failed', error: '503 upstream busy' } : { status: 'completed' }
          },
        },
      },
      retry: { maxRetries: 2, maxWaitMs: 60_000, maxDelayMs: 1, random: () => 1 },
    })
    const observation = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(newAttempts).toBe(2)
    expect(observation.outcome).toEqual({ status: 'completed' })
  })
})

describe('异常 / 拒绝 / 旧 token / 后台任务的生命周期责任', () => {
  test('provider 抛异常终止后 owner 释放，同一 session 可以再启动新 run', async () => {
    const host = createParityHost({ runtime: 'pi' })
    let attempts = 0
    const engine = createNewEngine({
      host,
      adapters: { pi: { runtime: 'pi', query: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('provider exploded')
        return { status: 'completed' }
      } } },
    })
    const first = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(first.outcome).toEqual({ status: 'failed', error: 'provider exploded' })
    expect(first.activeAfter).toBe(false)
    expect(engine.coordinator.ownership.ownerCount()).toBe(0)
    const second = await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
    expect(second.outcome).toEqual({ status: 'completed' })
    expect(attempts).toBe(2)
  })

  test('被拒绝的并发请求不影响 owner 的 stopAndWait 语义', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const host = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({
      host,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            yield sdk({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null })
            await gate
            yield sdk({ type: 'result', subtype: 'success' })
          })(),
          stop: async () => { release() },
        },
      },
    })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await waitFor(() => engine.recording.providerStarts === 1)
    const rejected = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await expect(rejected.handle.promise).rejects.toBeInstanceOf(AgentRunAlreadyActiveError)
    // 拒绝请求不改变 owner 的停止路由：stopAndWait 仍等到真实终态与 owner 释放。
    const stopping = engine.coordinator.stopAndWait('parity-session')
    release()
    await stopping
    expect(engine.coordinator.isRunning('parity-session')).toBe(false)
    expect((await running.observation).outcome).toEqual({ status: 'stopped' })
  })

  test('新 run 接管后，旧 token 的释放被拒绝（旧 token 清理）', async () => {
    const ownership = createAgentRunOwnershipRegistry()
    const host = createParityHost({ runtime: 'pi' })
    const coordinator = new AgentRuntimeCoordinator({
      ownership,
      ports: host.ports,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> { yield sdk({ type: 'result', subtype: 'success' }) })(),
          query: async () => ({ status: 'completed' }),
        },
      },
    })
    await expect(coordinator.run({ sessionId: 'parity-session', runtime: 'pi', prompt: 'p', ownershipToken: 'old-run-token' }).promise)
      .resolves.toEqual({ status: 'completed' })
    // 旧 run 已经收敛：它的延迟释放是 no-op，不会误删后续 owner。
    expect(ownership.release('parity-session', 'old-run-token')).toBe(false)
    expect(ownership.claim({ sessionId: 'parity-session', runtime: 'pi', token: 'new-run-token' }).ok).toBe(true)
    expect(ownership.release('parity-session', 'old-run-token')).toBe(false)
    expect(ownership.getOwner('parity-session')?.token).toBe('new-run-token')
  })

  test('后台任务未结束：result 已到达但流未关闭时 owner 不释放，stopAndWait 等到流真正结束', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const host = createParityHost({ runtime: 'pi' })
    const engine = createNewEngine({
      host,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: () => (async function* stream(): AsyncGenerator<SDKMessage> {
            yield sdk({ type: 'result', subtype: 'success', _keepChannelOpenForTasks: true })
            await gate
            yield sdk({ type: 'assistant', message: { content: [{ type: 'text', text: 'wakeup' }] }, parent_tool_use_id: null })
          })(),
          stop: async () => { release() },
        },
      },
    })
    const running = engine.start({ sessionId: 'parity-session', channelId: 'parity-channel' })
    await waitFor(() => host.session.appendCalls.length >= 1)
    // 后台任务续轮场景：result 已到达，但 provider 流仍未关闭，执行权不得提前释放。
    expect(engine.coordinator.isRunning('parity-session')).toBe(true)
    let stoppedAndWaited = false
    const stopping = engine.coordinator.stopAndWait('parity-session').then(() => { stoppedAndWaited = true })
    release()
    await stopping
    expect(stoppedAndWaited).toBe(true)
    expect(engine.coordinator.isRunning('parity-session')).toBe(false)
    expect((await running.observation).outcome).toEqual({ status: 'stopped' })
  })
})
