/**
 * runtime-migration-parity / 旧引擎（AgentOrchestrator）driver
 *
 * 用切片编译执行**真实** `agent-orchestrator.ts`，注入边界依赖：
 * - 不导入 Electron 单例、不访问用户目录、不写磁盘、不构造真实 Claude/Pi adapter。
 * - 模块循环（orchestrator → agent-collaboration-tools → agent-service → orchestrator）
 *   导致直接 `import` 会在初始化期抛 TDZ 错误，因此必须切片编译（见 `compile-slice.ts`）。
 *
 * 实测可达到范围：**完整到达 `adapter.query` 并消费 provider 流**（含重试循环与终态），
 * 前提是调用方提供 `createOldEngineDeps` 的依赖表。provider 之前的 `mkdirSync` /
 * `writeFileSync(.claude/settings.json)` 已由 fs 替身接管，不会写磁盘。
 *
 * 未覆盖（明确声明）：
 * - `promptMode === 'standard'` 分支会 `import('@earendil-works/pi-coding-agent')` 并装配
 *   preset/skill/MCP 工具，本套件的 provider 级对照用例使用 `light` 模式（简单问候语），
 *   标准模式的可见性由 `capability-snapshot.parity.ts` 的清单与源码切片覆盖。
 * - 真实 Claude/Pi SDK 传输、真实 JSONL 落盘、Electron 实机启动（基线同样声明不覆盖）。
 */

import { isThinkingSignatureError } from '@profer/shared'
import type { AgentProviderAdapter, AgentRuntime, AgentSendInput, AgentSessionMeta, SDKMessage } from '@profer/shared'
import type { AgentOrchestrator, SessionCallbacks } from '../../agent-orchestrator'
import type { AgentRunOwnershipRegistry } from '@profer/agent-runtime'
import { extractErrorDetails, friendlyErrorMessage, isPromptTooLongError, mapSDKErrorToTypedError } from '../../adapters/pi-agent-adapter'
import { compileSlice, readMainSource } from './compile-slice'
import { createOldEngineDeps, type OldEngineFsRecord } from './old-engine-deps'
import type { ParityHostFixture } from './parity-host'

export interface OldEngineChannel {
  id: string
  name?: string
  provider: string
  enabled: boolean
  agentRuntimes: AgentRuntime[]
  models: Array<{ id: string; context1m?: boolean | null }>
  directDataPlane?: boolean
}

export interface OldEngineOptions {
  host: ParityHostFixture
  input: AgentSendInput
  sessionMeta?: AgentSessionMeta | undefined
  channel?: OldEngineChannel
  routingFailure?: boolean
  adapter?: Partial<AgentProviderAdapter>
  retryDelayMs?: (attempt: number, elapsedMs: number, category: unknown) => number
  preset?: Record<string, unknown>
  fs?: OldEngineFsRecord
  /** 共享执行权登记表；传入同一个实例即可与新引擎（coordinator）互斥。 */
  ownership?: AgentRunOwnershipRegistry
}

export interface OldEngineRecording {
  providerStarts: number
  providerStops: number
  abortCalls: string[]
  permissionCleanups: string[]
  /** 每次 provider 查询收到的 options（用于能力快照清单的实测证据）。 */
  providerQueries: Array<Record<string, unknown>>
  fs: OldEngineFsRecord
}

export interface OldObservation {
  threw: string | undefined
  errors: string[]
  completions: Array<{
    stoppedByUser: boolean
    endReason: string | undefined
    resultSubtype: string | undefined
    backgroundTasksPending: boolean
    messageCount: number | undefined
  }>
  runOwned: number
  runStarted: number
  providerStarts: number
  providerStops: number
  activeAfter: boolean
  goalOwnerAfter: boolean
}

export interface OldEngineDriver {
  instance: AgentOrchestrator
  input: AgentSendInput
  recording: OldEngineRecording
  callbacks: (overrides?: Partial<SessionCallbacks>) => SessionCallbacks
  run: (input?: AgentSendInput, overrides?: Partial<SessionCallbacks>) => Promise<OldObservation>
}

const orchestratorSource = readMainSource('agent-orchestrator.ts')

/** 取同一份真实类源码（每次建 driver 都新建类，保证用例间 ownership 状态隔离）。 */
function orchestrateClassSource(): string {
  return orchestratorSource.slice(orchestratorSource.indexOf('export class AgentOrchestrator'))
}

/** 真实 provider 错误分类 helper（来自 Pi adapter 的导出；不涉及该 adapter 的 query 路径）。 */
function realErrorHelpers(): AgentProviderAdapter['errorHelpers'] {
  return {
    friendlyErrorMessage,
    isPromptTooLongError,
    isThinkingSignatureError,
    mapSDKErrorToTypedError,
    extractErrorDetails,
    shouldKeepChannelOpen: () => false,
  }
}

/** 构造旧的 provider adapter 替身，记录每次查询与 abort。 */
function createAdapter(options: OldEngineOptions, recording: OldEngineRecording): AgentProviderAdapter {
  const base: AgentProviderAdapter = {
    query: (queryOptions) => {
      recording.providerStarts += 1
      recording.providerQueries.push(queryOptions as unknown as Record<string, unknown>)
      const stream = options.adapter?.query
      if (stream) return stream(queryOptions)
      return (async function* emptyStream(): AsyncGenerator<SDKMessage> {})()
    },
    abort: (sessionId: string) => {
      recording.providerStops += 1
      recording.abortCalls.push(sessionId)
      options.adapter?.abort?.(sessionId)
    },
    dispose: () => { options.adapter?.dispose?.() },
    errorHelpers: realErrorHelpers(),
  }
  return {
    ...base,
    ...options.adapter,
    // query/abort 必须保留计数包装；其余可选方法用调用方覆盖。
    query: base.query,
    abort: base.abort,
    dispose: base.dispose,
    errorHelpers: options.adapter?.errorHelpers ?? base.errorHelpers,
  }
}

export function createOldEngine(options: OldEngineOptions): OldEngineDriver {
  const { host } = options
  const channel: OldEngineChannel = options.channel ?? {
    id: 'parity-channel',
    provider: 'custom',
    enabled: true,
    agentRuntimes: ['claude', 'pi'],
    models: [{ id: 'parity-model' }],
  }
  const recording: OldEngineRecording = {
    providerStarts: 0,
    providerStops: 0,
    abortCalls: [],
    permissionCleanups: [],
    providerQueries: [],
    fs: options.fs ?? { writes: [], mkdirs: [] },
  }

  const permissionPort = {
    ...(host.legacyPorts.permissions ?? {}),
    clearSessionPending: (sessionId: string) => { recording.permissionCleanups.push(`pending:${sessionId}`) },
    clearSessionWhitelist: (sessionId: string) => { recording.permissionCleanups.push(`whitelist:${sessionId}`) },
  }

  const deps = createOldEngineDeps({
    getSessionMeta: () => options.sessionMeta ?? host.session.meta,
    getSessionMessages: () => host.session.sdkMessages,
    appendMessages: (sessionId, messages) => { host.sessions.appendMessages(sessionId, messages) },
    updateMeta: (sessionId, patch) => { host.sessions.updateMeta(sessionId, patch) },
    lockRuntime: (sessionId, runtime) => host.sessions.lockRuntime
      ? host.sessions.lockRuntime(sessionId, runtime)
      : (host.session.meta as AgentSessionMeta),
    channel,
    credentialsResolve: async () => {
      // 复用 host 的凭据端口，保证新旧两侧凭据语义同源。
      const runtime = host.session.meta?.agentRuntime ?? 'pi'
      return await host.ports.credentials!.resolve({ sessionId: options.input.sessionId, runtime })
    },
    eventPortEmit: (sessionId, payload) => host.legacyPorts.events!.emit(sessionId, payload as never),
    permissionPort,
    eventBus: host.legacyEventBus,
    fs: recording.fs,
    ...(options.retryDelayMs ? { retryDelayMs: options.retryDelayMs } : {}),
    ...(options.routingFailure ? { routePluginModel: () => { throw new Error('routing failed') } } : {}),
    ...(options.preset ? { preset: options.preset } : {}),
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  })

  const OrchestratorClass = compileSlice<typeof AgentOrchestrator>(orchestrateClassSource(), 'AgentOrchestrator', deps)
  const adapter = createAdapter(options, recording)
  const instance = new OrchestratorClass(
    adapter,
    host.legacyEventBus as unknown as ConstructorParameters<typeof AgentOrchestrator>[1],
    {
      sessions: host.legacyPorts.sessions,
      credentials: host.legacyPorts.credentials,
      resources: host.legacyPorts.resources,
      permissions: permissionPort as never,
      events: host.legacyPorts.events,
      ...(host.legacyPorts.toolAssembly ? { toolAssembly: host.legacyPorts.toolAssembly } : {}),
    } as ConstructorParameters<typeof AgentOrchestrator>[2],
    options.ownership,
  )

  const callbacks = (overrides: Partial<SessionCallbacks> = {}): SessionCallbacks => ({
    onError: overrides.onError ?? (() => {}),
    onComplete: overrides.onComplete ?? (() => {}),
    onTitleUpdated: overrides.onTitleUpdated ?? (() => {}),
    ...(overrides.onRunOwned ? { onRunOwned: overrides.onRunOwned } : {}),
    ...(overrides.onRunStarted ? { onRunStarted: overrides.onRunStarted } : {}),
  })

  return {
    instance,
    input: options.input,
    recording,
    callbacks,
    run: async (input, overrides = {}) => {
      const target = input ?? options.input
      const errors: string[] = []
      const completions: OldObservation['completions'] = []
      let runOwned = 0
      let runStarted = 0
      let threw: string | undefined
      const merged = callbacks({
        onTitleUpdated: title => overrides.onTitleUpdated?.(title),
        onError: error => { errors.push(error); overrides.onError?.(error) },
        onComplete: (messages, opts) => {
          completions.push({
            stoppedByUser: opts?.stoppedByUser === true,
            endReason: opts?.endReason,
            resultSubtype: opts?.resultSubtype,
            backgroundTasksPending: opts?.backgroundTasksPending === true,
            messageCount: messages?.length,
          })
          overrides.onComplete?.(messages, opts)
        },
        onRunOwned: () => { runOwned += 1; overrides.onRunOwned?.() },
        onRunStarted: async ({ startedAt }) => { runStarted += 1; await overrides.onRunStarted?.({ startedAt }) },
      })
      try {
        await instance.sendMessage(target, merged)
      } catch (error) {
        threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }
      return {
        threw,
        errors,
        completions,
        runOwned,
        runStarted,
        providerStarts: recording.providerStarts,
        providerStops: recording.providerStops,
        activeAfter: instance.isActive(target.sessionId),
        goalOwnerAfter: target.goalRunId ? instance.isGoalRunActive(target.sessionId, target.goalRunId) : false,
      }
    },
  }
}
