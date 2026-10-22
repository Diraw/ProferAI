/**
 * runtime-migration-parity / 内存宿主 fixture
 *
 * 旧 orchestrator 与新 runtime coordinator 由**同一份**宿主端口驱动，从而把差异
 * 收敛到引擎本身，而不是"两边各写一套 mock 再互相对不上"。
 *
 * 语义对齐声明（重要）：
 * - 本 fixture 的 SessionPort / CredentialPort / PermissionPort 是**内存实现**，不读写
 *   用户目录、不调用真实密钥环。它们按 `packages/agent-runtime/src/ports.ts` 的契约
 *   注释实现可观察语义（lockRuntime 同步抛错、appendMessages 同步落盘、updateMeta
 *   同步写回）。真实实现（`agent-session-manager` / `agent-runtime-host`）不在本套件
 *   覆盖范围内，本套件不宣称已验证真实 JSONL 落盘。
 * - `lockRuntime` 的 mismatch 判定与真实 `lockAgentSessionRuntime` 同义：会话已绑定
 *   另一内核时抛 `AgentSessionRuntimeMismatchError`；`enforceRuntimeLock: false` 用于
 *   复现"端口未提供该可选方法"的缺口。
 */

import { AgentSessionRuntimeMismatchError, normalizeAgentRuntime } from '@profer/shared'
import type {
  AgentMessage,
  AgentRuntime,
  AgentSessionMeta,
  AgentStreamPayload,
  SDKMessage,
} from '@profer/shared'
import type {
  AgentRuntimeEvent,
  AgentRuntimePorts,
  CredentialPort,
  PermissionPort,
  SessionPort,
} from '@profer/agent-runtime'

/** 旧 orchestrator 构造函数接收的 ports 子集（缺 host / providerQueryPreparation）。 */
export interface LegacyOrchestratorPorts {
  sessions: AgentRuntimePorts['sessions']
  credentials: AgentRuntimePorts['credentials']
  resources: AgentRuntimePorts['resources']
  permissions: AgentRuntimePorts['permissions']
  events: AgentRuntimePorts['events']
  toolAssembly?: AgentRuntimePorts['toolAssembly']
  preview?: AgentRuntimePorts['preview']
  queryPreparation?: AgentRuntimePorts['queryPreparation']
}

export type CredentialMode =
  | 'ok'
  | { ok: false; code: 'token_expired' | 'api_key_decrypt_failed' }

export interface ParityHostOptions {
  runtime?: AgentRuntime
  meta?: AgentSessionMeta
  /** 凭证解析结果；'pending' 表示解析挂起，由 `resolveCredentials()` 手动结算。 */
  credentials?: CredentialMode | 'pending'
  /** lockRuntime 的失败注入：'mismatch' 走真实 mismatch 语义，'storage' 走写盘失败。 */
  lockRuntimeFailure?: 'mismatch' | 'storage'
  /** false 时完全不提供 `lockRuntime`（复现可选端口缺失）。默认 true。 */
  provideLockRuntime?: boolean
  /** 是否执行 mismatch 校验（仅 new 路径依赖它）。默认 true。 */
  enforceRuntimeLock?: boolean
  queryPreparation?: AgentRuntimePorts['queryPreparation']
  providerQueryPreparation?: AgentRuntimePorts['providerQueryPreparation']
  toolAssembly?: AgentRuntimePorts['toolAssembly']
  permission?: Partial<PermissionPort>
  resources?: AgentRuntimePorts['resources']
  /** 会话消息持久化抛错注入（用于"副作用失败后是否释放 owner"）。 */
  appendMessagesFailure?: string
}

export interface ParityHostFixture {
  ports: AgentRuntimePorts
  legacyPorts: LegacyOrchestratorPorts
  /** 与 `ports.sessions` 同一对象；旧引擎的 deps 表直接用它的同步语义。 */
  sessions: SessionPort
  session: {
    meta: AgentSessionMeta | undefined
    sdkMessages: SDKMessage[]
    agentMessages: AgentMessage[]
    appendCalls: SDKMessage[][]
    metaPatches: Array<Partial<AgentSessionMeta>>
    lockAttempts: Array<{ sessionId: string; runtime: AgentRuntime; accepted: boolean }>
  }
  events: {
    /** 旧路径 eventPort.emit（AgentStreamPayload）。 */
    legacy: AgentStreamPayload[]
    /** 新路径 host.emit（AgentRuntimeEvent）。 */
    runtime: AgentRuntimeEvent[]
    /** 两侧共用的 EventPort.emit（权限 / askUser 请求事件）。 */
    eventPort: AgentStreamPayload[]
  }
  /** 统一有序日志，用于跨引擎比较"事情发生的顺序"。 */
  log: string[]
  credentialCalls: Array<{ sessionId: string; runtime: AgentRuntime; channelId?: string; modelId?: string }>
  resolveCredentials(): void
  /** 旧路径需要的 eventBus 替身（emit 记录到 events.legacy）。 */
  legacyEventBus: { emit(sessionId: string, payload: AgentStreamPayload): void; on(): () => void }
}

const defaultMeta = (runtime: AgentRuntime): AgentSessionMeta => ({
  id: 'parity-session',
  title: 'parity fixture',
  agentRuntime: runtime,
  createdAt: 1,
  updatedAt: 1,
})

/**
 * 构建一份可被新旧引擎同时消费的宿主 fixture。
 *
 * 所有记录都在内存中，且不触碰 electron / 文件系统 / 网络。
 */
export function createParityHost(options: ParityHostOptions = {}): ParityHostFixture {
  const runtime = options.runtime ?? 'pi'
  const state = {
    meta: options.meta === undefined ? defaultMeta(runtime) : options.meta,
    sdkMessages: [] as SDKMessage[],
    agentMessages: [] as AgentMessage[],
    appendCalls: [] as SDKMessage[][],
    metaPatches: [] as Array<Partial<AgentSessionMeta>>,
    lockAttempts: [] as Array<{ sessionId: string; runtime: AgentRuntime; accepted: boolean }>,
  }
  const events = {
    legacy: [] as AgentStreamPayload[],
    runtime: [] as AgentRuntimeEvent[],
    eventPort: [] as AgentStreamPayload[],
  }
  const log: string[] = []
  const credentialCalls: ParityHostFixture['credentialCalls'] = []

  const credentialMode: CredentialMode | 'pending' = options.credentials ?? 'ok'
  let pendingResolve: (() => void) | undefined
  let pendingGate: Promise<void> | undefined
  if (credentialMode === 'pending') {
    // 无论调用方何时结算都能解锁：先建 gate，resolve() 只 await 它。
    pendingGate = new Promise<void>(resolve => { pendingResolve = resolve })
  }
  const credentialResult = credentialMode === 'ok' || credentialMode === 'pending'
    ? { ok: true as const, credentials: { apiKey: 'parity-key', baseUrl: undefined, provider: 'custom' as const, forceBearerAuth: false } }
    : credentialMode

  const sessions: SessionPort = {
    getMeta: () => state.meta,
    appendMessages(sessionId, messages): undefined {
      log.push(`session.append:${sessionId}:${messages.length}`)
      if (options.appendMessagesFailure) throw new Error(options.appendMessagesFailure)
      state.appendCalls.push([...messages])
      state.sdkMessages.push(...messages)
    },
    updateMeta(_sessionId, patch): undefined {
      log.push('session.updateMeta')
      state.metaPatches.push(patch)
      if (state.meta) state.meta = { ...state.meta, ...patch }
    },
    getMessages: () => state.sdkMessages,
    getAgentMessages: () => state.agentMessages,
    ...(options.provideLockRuntime === false ? {} : {
      lockRuntime(sessionId: string, requested: AgentRuntime): AgentSessionMeta {
        const current = normalizeAgentRuntime(state.meta?.agentRuntime)
        if (options.lockRuntimeFailure === 'storage') {
          state.lockAttempts.push({ sessionId, runtime: requested, accepted: false })
          log.push(`session.lockFailed:${requested}`)
          throw new Error('lock write failed')
        }
        if (options.enforceRuntimeLock !== false && state.meta && current !== requested) {
          state.lockAttempts.push({ sessionId, runtime: requested, accepted: false })
          log.push(`session.lockRejected:${current}->${requested}`)
          throw new AgentSessionRuntimeMismatchError(current, requested)
        }
        state.lockAttempts.push({ sessionId, runtime: requested, accepted: true })
        log.push(`session.lock:${requested}`)
        if (state.meta) {
          state.meta = { ...state.meta, agentRuntime: requested, agentRuntimeLocked: true, revision: (state.meta.revision ?? 0) + 1 }
        }
        return state.meta as AgentSessionMeta
      },
    }),
  }

  const credentials: CredentialPort = {
    async resolve(input) {
      credentialCalls.push({ sessionId: input.sessionId, runtime: input.runtime, channelId: input.channelId, modelId: input.modelId })
      log.push(`credentials.resolve:${input.runtime}`)
      if (credentialMode === 'pending') {
        // 无论调用方何时结算都能解锁：先建 gate，resolve() 只 await 它。
        await pendingGate
        return { ok: false, code: 'token_expired' }
      }
      return credentialResult
    },
  }

  const resources: AgentRuntimePorts['resources'] = options.resources ?? { load: () => ({}) }

  const permission: PermissionPort = {
    createCanUseTool: () => async () => ({ behavior: 'deny', message: 'parity fixture: 未授权' }),
    ...options.permission,
  }

  const eventPort = { emit: (_sessionId: string, payload: AgentStreamPayload): void => { log.push(`eventPort:${payload.kind}`); events.eventPort.push(payload) } }
  const host = { emit: (event: AgentRuntimeEvent): void => { log.push(`host:${event.type}`); events.runtime.push(event) } }

  const ports: AgentRuntimePorts = {
    sessions,
    credentials,
    resources,
    permissions: permission,
    events: eventPort,
    host,
    ...(options.queryPreparation ? { queryPreparation: options.queryPreparation } : {}),
    ...(options.providerQueryPreparation ? { providerQueryPreparation: options.providerQueryPreparation } : {}),
    ...(options.toolAssembly ? { toolAssembly: options.toolAssembly } : {}),
  }

  const legacyPorts: LegacyOrchestratorPorts = {
    sessions,
    credentials,
    resources,
    permissions: permission,
    events: eventPort,
    ...(options.toolAssembly ? { toolAssembly: options.toolAssembly } : {}),
    ...(options.queryPreparation ? { queryPreparation: options.queryPreparation } : {}),
  }

  return {
    ports,
    legacyPorts,
    sessions,
    session: state,
    events,
    log,
    credentialCalls,
    resolveCredentials: () => { pendingResolve?.(); pendingResolve = undefined },
    legacyEventBus: {
      emit: (sessionId, payload) => { log.push(`legacyBus:${payload.kind}`); events.legacy.push(payload) },
      on: () => () => {},
    },
  }
}
