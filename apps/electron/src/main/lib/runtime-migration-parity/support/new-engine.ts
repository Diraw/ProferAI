/**
 * runtime-migration-parity / 新引擎（AgentRuntimeCoordinator）driver
 *
 * 新路径可以直接 import（`@profer/agent-runtime` 不含 Electron / 文件系统依赖），
 * 因此这里**不做切片编译**：直接用真实类 + 真实 port 契约驱动。
 */

import type {
  AgentRuntimeAdapter,
  AgentRuntimeCallbacks,
  AgentRuntimeQuery,
  AgentRuntimeRunHandle,
  AgentRunOutcome,
} from '@profer/agent-runtime'
import { AgentRuntimeCoordinator } from '@profer/agent-runtime'
import type { AgentRuntime } from '@profer/shared'
import type { ParityHostFixture } from './parity-host'

export interface NewEngineRetryPolicy {
  maxRetries?: number
  maxWaitMs?: number
  maxDelayMs?: number
  random?: () => number
  shouldRetry?: (error: string) => boolean
}

/**
 * 适配器输入：`stream` / `query` 至少提供一个。
 *
 * 不用完整 `AgentRuntimeAdapter`（其 `query` 为必填）是为了让用例只声明它真正关心的一面，
 * 缺的另一面由 `recordingAdapter` 补默认值；coordinator 本来也只要求二者之一。
 */
export interface NewEngineAdapterInput {
  /** 冗余声明（与 adapters 的 key 同义）：用例里写成 `{ runtime: 'pi', stream }` 更易读，这里显式允许。 */
  runtime?: AgentRuntime
  query?: AgentRuntimeAdapter['query']
  stream?: AgentRuntimeAdapter['stream']
  stop?: AgentRuntimeAdapter['stop']
  dispose?: AgentRuntimeAdapter['dispose']
  getCapabilities?: AgentRuntimeAdapter['getCapabilities']
}

export interface NewEngineOptions {
  host: ParityHostFixture
  adapters: Partial<Record<AgentRuntime, NewEngineAdapterInput>>
  retry?: NewEngineRetryPolicy
  now?: () => number
}

export interface NewObservation {
  outcome: AgentRunOutcome | undefined
  /** run promise 被拒绝时的错误文本（新路径在 lockRuntime / 持久化失败时 reject）。 */
  rejected: string | undefined
  errors: string[]
  /** onComplete 回调实际收到的终态序列；用于验证"终态一次性"。 */
  outcomes: AgentRunOutcome[]
  runStarted: number
  providerStarts: number
  providerStops: number
  activeAfter: boolean
}

export interface NewEngineRecording {
  providerStarts: number
  providerStops: number
  stopReasons: string[]
}

export interface NewEngineDriver {
  coordinator: AgentRuntimeCoordinator
  recording: NewEngineRecording
  /** 发起一次 run（不等待），返回 handle 与观测 promise。 */
  start: (
    input: Partial<AgentRuntimeQuery> & Pick<AgentRuntimeQuery, 'sessionId'>,
    overrides?: Partial<AgentRuntimeCallbacks>,
  ) => { handle: AgentRuntimeRunHandle; observation: Promise<NewObservation> }
  /** 直接 await 终态。 */
  run: (
    input: Partial<AgentRuntimeQuery> & Pick<AgentRuntimeQuery, 'sessionId'>,
    overrides?: Partial<AgentRuntimeCallbacks>,
  ) => Promise<NewObservation>
}

/** 把 provider 行为包一层计数/停止记录，使两侧观察维度一致。 */
export function recordingAdapter(
  runtime: AgentRuntime,
  impl: NewEngineAdapterInput,
  recording: NewEngineRecording,
): AgentRuntimeAdapter {
  return {
    runtime,
    query: async (input, callbacks) => {
      recording.providerStarts += 1
      return impl.query ? await impl.query(input, callbacks) : { status: 'completed' }
    },
    ...(impl.stream ? {
      stream: (input: AgentRuntimeQuery, callbacks?: AgentRuntimeCallbacks) => {
        recording.providerStarts += 1
        return impl.stream!(input, callbacks)
      },
    } : {}),
    ...(impl.stop ? {
      stop: async (reason?: string, sessionId?: string) => {
        recording.providerStops += 1
        recording.stopReasons.push(reason ?? 'stopped_by_user')
        await impl.stop?.(reason, sessionId)
      },
    } : {}),
    ...(impl.dispose ? { dispose: impl.dispose } : {}),
    ...(impl.getCapabilities ? { getCapabilities: impl.getCapabilities } : {}),
  }
}

export function createNewEngine(options: NewEngineOptions): NewEngineDriver {
  const recording: NewEngineRecording = { providerStarts: 0, providerStops: 0, stopReasons: [] }
  const adapters: Partial<Record<AgentRuntime, AgentRuntimeAdapter>> = {}
  for (const runtime of Object.keys(options.adapters) as AgentRuntime[]) {
    const adapter = options.adapters[runtime]
    if (adapter) adapters[runtime] = recordingAdapter(runtime, adapter, recording)
  }
  const coordinator = new AgentRuntimeCoordinator({
    adapters,
    ports: options.host.ports,
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.now ? { now: options.now } : {}),
  })

  const start: NewEngineDriver['start'] = (input, overrides = {}) => {
    const errors: string[] = []
    const outcomes: AgentRunOutcome[] = []
    let runStarted = 0
    const callbacks: AgentRuntimeCallbacks = {
      onEvent: event => { overrides.onEvent?.(event) },
      onError: error => {
        errors.push(error instanceof Error ? error.message : String(error))
        overrides.onError?.(error)
      },
      onComplete: outcome => {
        outcomes.push(outcome)
        overrides.onComplete?.(outcome)
      },
      onRunStarted: async ({ startedAt }) => { runStarted += 1; await overrides.onRunStarted?.({ startedAt }) },
      onMessage: message => { overrides.onMessage?.(message) },
    }
    const query: AgentRuntimeQuery = {
      ...input,
      prompt: input.prompt ?? 'parity prompt',
      runtime: input.runtime ?? options.host.session.meta?.agentRuntime ?? 'pi',
      sessionId: input.sessionId,
    }
    const handle = coordinator.run(query, callbacks)
    const snapshot = (outcome: AgentRunOutcome | undefined, rejected: string | undefined): NewObservation => ({
      outcome,
      rejected,
      errors,
      outcomes,
      runStarted,
      providerStarts: recording.providerStarts,
      providerStops: recording.providerStops,
      activeAfter: coordinator.isRunning(query.sessionId),
    })
    const observation = handle.promise.then(
      outcome => snapshot(outcome, undefined),
      (error: unknown) => snapshot(undefined, error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
    )
    return { handle, observation }
  }

  return {
    coordinator,
    recording,
    start,
    run: (input, overrides) => start(input, overrides).observation,
  }
}
