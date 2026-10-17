/**
 * agent-runtime-native-session-persistence — 原生 session ID / Pi artifact 的宿主侧持久化适配器
 *
 * 背景（来源：`parity/failures.md` 缺口 #31、`05-next-slice.md` D1/D2、
 * `SEAM-RESUME-NATIVE-ID`）：
 * 旧路径在 `agent-orchestrator.ts` 的 provider query options 上挂了两个回调，把 provider 事实
 * 落进会话元数据：
 * - `onSessionId(sdkSessionId, piSessionFile?)` → `updateMeta({ sdkSessionId, piSessionFile?, piEntryBindings? })`
 * - `onPiEntryBindings(bindings)` → 合并 `piEntryBindings`（并做检查点回收）
 *
 * 新路径 coordinator 完全不承担这件事（`sdkSessionId` / `onSessionId` 在 coordinator 中出现 0 次），
 * 而 provider（Pi / Claude）**已经**在 `AgentQueryInput` 上提供了这两个回调。
 * 因此责任方是**宿主**：provider 提供原生 ID，宿主持久化。本模块就是那个宿主侧适配器。
 *
 * 复用而非重写：规则逐条对齐旧实现，不新增判据、不改 provider。
 * - 仅在 session id **真正变化**时写盘（SDK v2 几乎每条消息都回调，无条件写会引发 fsync 风暴）；
 * - Pi artifact 真正**更换**时原子重置 `piEntryBindings`（旧 bindings 属于另一棵 Pi tree）；
 * - `isolatedRuntimeSession` 时**不落盘**，只把原生 ID 透传给调用方（Goal 的隔离会话语义）。
 *
 * 边界：
 * - 本模块只做「给定 provider 回调 → 元数据补丁」的纯映射，**不**自己写盘；
 *   调用方拿到补丁后交给 `SessionPort.updateMeta`（便于单测与审计）。
 * - checkpoint（`piFileCheckpoints`）的创建 / 回收策略由**宿主持有**的模块实现
 *   （`pi-file-checkpoint-lifecycle.ts`，GAP-2），经 `checkpointLifecycle`（或等价的
 *   `resolveCheckpointPatch`）注入。本模块不认识 `createPiFileCheckpoint`，
 *   因此新路径不依赖旧编排器内部实现。
 */

import type { SessionPort } from '@profer/agent-runtime'
import type { AgentSessionMeta } from '@profer/shared'

/** provider 侧原生 ID 回调的既有签名（`AgentQueryInput`）：Pi 带 sessionFile，Claude 不带。 */
export type NativeSessionIdCallback = (sdkSessionId: string, piSessionFile?: string) => void

/** Pi entry 绑定回调的既有签名：assistant UUID → Pi entry ID。 */
export type PiEntryBindingsCallback = (bindings: Record<string, string>) => void

export interface NativeSessionPersisterOptions {
  sessions: Pick<SessionPort, 'getMeta' | 'updateMeta'>
  sessionId: string
  /** 旧路径 `input.isolatedRuntimeSession`：隔离会话只透传原生 ID，不落盘。 */
  isolatedRuntimeSession?: boolean
  /** 隔离会话的原生 ID 透传目标（旧路径 `input.onRuntimeSessionId`）。 */
  onRuntimeSessionId?: (sdkSessionId: string, piSessionFile?: string) => void
  /** 初始已捕获的 session id；旧路径用「本次 run 开始前的 existingSdkSessionId」初始化。 */
  initialSdkSessionId?: string
  /**
   * 宿主持有的检查点生命周期（可选注入，GAP-2）。
   *
   * 传入 `beginPiCheckpointTurn()` 的返回值即可：本轮检查点由宿主在**provider 启动之前**创建，
   * 这里只负责在 `onPiEntryBindings` 时把 entry 绑定到检查点并回收旧条目。
   * 不注入时只合并 `piEntryBindings`，不触碰检查点字段。
   */
  checkpointLifecycle?: {
    resolveCheckpointPatch(input: {
      bindings: Record<string, string>
      meta: AgentSessionMeta | undefined
    }): Partial<AgentSessionMeta> | undefined
  }
  /**
   * 低层等价注入位（与 `checkpointLifecycle.resolveCheckpointPatch` 同义）。
   * 两者同时提供时以本字段为准，便于宿主直接传函数。
   */
  resolveCheckpointPatch?: (input: {
    bindings: Record<string, string>
    meta: AgentSessionMeta | undefined
  }) => Partial<AgentSessionMeta> | undefined
  logger?: { log(message: string): void; error(message: string, error: unknown): void }
}

export interface NativeSessionPersister {
  /** 挂到 provider query options 的 `onSessionId`。 */
  onSessionId: NativeSessionIdCallback
  /** 挂到 provider query options 的 `onPiEntryBindings`。 */
  onPiEntryBindings: PiEntryBindingsCallback
  /** 本次 run 内最后一次观察到的原生 session id（旧路径 `capturedSdkSessionId`）。 */
  readonly capturedSdkSessionId: string | undefined
}

const noopLogger = { log: () => {}, error: () => {} }

/**
 * 创建宿主侧原生 session 持久化器。
 *
 * 两个回调都**返回本次实际写入的补丁**（`undefined` 表示按规则无需写盘），
 * 便于直接单测「何时写 / 何时不写」，也便于宿主把补丁并入自己的批量写。
 */
export function createNativeSessionPersister(
  options: NativeSessionPersisterOptions,
): NativeSessionPersister & {
  onSessionIdPatch: (sdkSessionId: string, piSessionFile?: string) => Partial<AgentSessionMeta> | undefined
  onPiEntryBindingsPatch: (bindings: Record<string, string>) => Partial<AgentSessionMeta> | undefined
} {
  const logger = options.logger ?? noopLogger
  let captured = options.initialSdkSessionId

  const onSessionIdPatch = (
    sdkSessionId: string,
    piSessionFile?: string,
  ): Partial<AgentSessionMeta> | undefined => {
    const latest = options.sessions.getMeta(options.sessionId)
    const isNewSessionId = sdkSessionId !== captured
    // Pi 同一 artifact 的每条消息都可能回调；只有 artifact 真正更换才视为替换。
    const artifactReplaced = Boolean(piSessionFile) && latest?.piSessionFile !== piSessionFile
    captured = sdkSessionId

    if (options.isolatedRuntimeSession) {
      if (isNewSessionId) options.onRuntimeSessionId?.(sdkSessionId, piSessionFile)
      return undefined
    }
    if (!isNewSessionId && !artifactReplaced) return undefined

    return {
      sdkSessionId,
      ...(piSessionFile ? { piSessionFile } : {}),
      ...(artifactReplaced ? { piEntryBindings: {} } : {}),
    }
  }

  const resolveCheckpointPatch = options.resolveCheckpointPatch
    ?? options.checkpointLifecycle?.resolveCheckpointPatch

  const onPiEntryBindingsPatch = (bindings: Record<string, string>): Partial<AgentSessionMeta> | undefined => {
    const latest = options.sessions.getMeta(options.sessionId)
    // 检查点回收是机会式 GC：即使 bindings 为空也要跑一次（旧链语义），
    // 否则一个「本轮没有新增 entry」的 run 会留下无人回收的旧检查点。
    const checkpointPatch = resolveCheckpointPatch?.({ bindings, meta: latest })
    const hasBindings = Object.keys(bindings).length > 0
    if (!hasBindings && !checkpointPatch) return undefined
    return {
      ...(hasBindings
        ? { piEntryBindings: { ...(latest?.piEntryBindings ?? {}), ...bindings } }
        : {}),
      ...(checkpointPatch ?? {}),
    }
  }

  return {
    onSessionId: (sdkSessionId, piSessionFile) => {
      const patch = onSessionIdPatch(sdkSessionId, piSessionFile)
      if (!patch) return
      try {
        options.sessions.updateMeta(options.sessionId, patch)
        logger.log(`已保存 SDK session_id: ${sdkSessionId}`)
      } catch (error) {
        logger.error('保存 SDK session_id 失败:', error)
      }
    },
    onPiEntryBindings: (bindings) => {
      const patch = onPiEntryBindingsPatch(bindings)
      if (!patch) return
      try {
        options.sessions.updateMeta(options.sessionId, patch)
      } catch (error) {
        logger.error('保存 Pi entry bindings 失败:', error)
      }
    },
    onSessionIdPatch,
    onPiEntryBindingsPatch,
    get capturedSdkSessionId() {
      return captured
    },
  }
}

/**
 * 把两个回调挂到 provider query options 上。
 *
 * 新路径的 provider options 由 `providerInput`（opaque `Record<string, unknown>`）透传，
 * `provider-bridge.toProviderInput` 会原样保留未知字段，因此宿主可以这样接线而不改 provider：
 *
 * ```ts
 * const persister = createNativeSessionPersister({ sessions, sessionId })
 * const query = createElectronAgentRuntimeQuery(input, {
 *   runtime, cwd,
 *   providerInput: { ...withNativeSessionCallbacks(undefined, persister) },
 * })
 * ```
 *
 * 这里只做「合并进已有 providerInput」的纯函数，避免宿主各处重复拼装。
 */
export function withNativeSessionCallbacks<T extends Readonly<Record<string, unknown>> | undefined>(
  providerInput: T,
  persister: Pick<NativeSessionPersister, 'onSessionId' | 'onPiEntryBindings'>,
): Record<string, unknown> {
  return {
    ...(providerInput ?? {}),
    onSessionId: persister.onSessionId,
    onPiEntryBindings: persister.onPiEntryBindings,
  }
}
