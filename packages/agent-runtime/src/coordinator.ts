import type { AgentRuntime, SDKMessage } from '@profer/shared'
import { AgentSessionRuntimeMismatchError, normalizeAgentRuntime } from '@profer/shared'
import type { AgentRuntimeEvent, AgentRunOutcome } from './events'
import { createAgentRunOutcomeReporter } from './outcome'
import { createAgentQueryPreparationPort, AgentRuntimePreparationError } from './query-preparation'
import type { AgentRuntimePreparationFailure } from './query-preparation'
import { createAgentRunOwnershipRegistry, createAgentRunRejectionError } from './run-ownership'
import type { AgentRunOwnershipRegistry, AgentRunOwnershipToken } from './run-ownership'
import { readAgentStreamNext } from './stream-reader'
import { canRetry, getRetryDelayMs, isRetryableError, waitForRetryDelay } from './retry'
import type { RetryPolicy } from './retry'
import type { AgentRuntimeAdapter, AgentRuntimeCallbacks, AgentRuntimePorts, AgentRuntimeQuery } from './contract'

/** 准备阶段失败的结构化描述；未知错误归入 `unknown` 阶段但仍如实上报。 */
function preparationFailureFrom(error: unknown, message: string): AgentRuntimePreparationFailure {
  if (error instanceof AgentRuntimePreparationError) {
    return { phase: error.phase, code: error.code, message }
  }
  return { phase: 'unknown', message }
}

/**
 * provider 的「轻量完成」注解：本轮 turn 主体结束但仍有后台任务在飞。
 * 由 adapter 打在 result 消息上（见 claude-agent-adapter 的 `_keepChannelOpenForTasks`）。
 */
function isKeepChannelOpenForTasks(message: SDKMessage): boolean {
  return (message as { _keepChannelOpenForTasks?: unknown })._keepChannelOpenForTasks === true
}

/**
 * 后台任务完成后的续轮首条消息。与旧编排层一致：assistant / user / task_started / task_progress
 * 视为唤醒信号，此时把 UI 从「空闲可输入」拉回运行态。
 */
function isBackgroundWakeMessage(message: SDKMessage): boolean {
  if (message.type === 'assistant' || message.type === 'user') return true
  if (message.type !== 'system') return false
  const subtype = (message as { subtype?: unknown }).subtype
  return subtype === 'task_started' || subtype === 'task_progress'
}

function isPartialRuntimeMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: unknown }> } }).message?.content
  return Array.isArray(content) && content.some(block => block?.type === 'tool_result')
}

/** 与旧编排层一致：只把用户可见转录写入历史，内部流控制消息仅实时投影。 */
function isPersistableRuntimeMessage(message: SDKMessage): boolean {
  if (isPartialRuntimeMessage(message) || (message as Record<string, unknown>).isReplay === true) return false
  if (message.type === 'assistant' || message.type === 'result') return true
  if (message.type === 'user') return hasToolResult(message)
  if (message.type !== 'system') return false
  const subtype = (message as { subtype?: unknown }).subtype
  return subtype === 'compact_boundary' || subtype === 'permission_denied'
}

function normalizeRuntimeMessage(message: SDKMessage, modelId: string | undefined, createdAt: number): SDKMessage {
  const record = message as Record<string, unknown>
  const normalized: Record<string, unknown> = {
    ...record,
    ...(typeof record._createdAt === 'number' ? {} : { _createdAt: createdAt }),
  }
  if (message.type === 'assistant' && modelId && !record._channelModelId) {
    normalized._channelModelId = modelId
  }
  return normalized as SDKMessage
}

function addRuntimeDuration(message: SDKMessage, startedAt: number, finishedAt: number): SDKMessage {
  if (message.type !== 'result') return message
  const record = message as Record<string, unknown>
  if (typeof record._durationMs === 'number') return message
  return { ...message, _durationMs: Math.max(0, finishedAt - startedAt) } as SDKMessage
}

async function consumeRuntimeStream(
  stream: AsyncIterable<SDKMessage>,
  signal: AbortSignal,
  callbacks: AgentRuntimeCallbacks,
  context: { sessionId: string; startedAt: number },
): Promise<AgentRunOutcome> {
  const iterator = stream[Symbol.asyncIterator]()
  let terminalResult: SDKMessage | undefined
  // 后台任务等待态：result 走轻量完成后置 true，续轮首条实质消息时发 run_resumed 并置回 false。
  let awaitingBackgroundWake = false
  while (true) {
    const next = await readAgentStreamNext(iterator, { shouldStop: () => signal.aborted })
    if (next.kind === 'stopped') return { status: 'stopped' }
    if (next.kind === 'done') break
    const message = next.value
    if (message.type === 'result') {
      terminalResult = message
      if (isKeepChannelOpenForTasks(message)) {
        // 轻量完成：不是终态。继续 park 在 iterator.next()，等后台任务完成后的续轮消息；
        // 期间不结算 outcome、不释放执行权，因此 UI 空闲可输入但主进程仍持有会话。
        awaitingBackgroundWake = true
        const result = message as { subtype?: unknown; errors?: unknown }
        await callbacks.onBackgroundTasksPending?.({
          startedAt: context.startedAt,
          ...(typeof result.subtype === 'string' ? { resultSubtype: result.subtype } : {}),
          ...(Array.isArray(result.errors)
            ? {
                resultErrors: result.errors.filter(
                  (value): value is string => typeof value === 'string' && value.trim().length > 0,
                ),
              }
            : {}),
        })
      }
    } else if (awaitingBackgroundWake && isBackgroundWakeMessage(message)) {
      // 唤醒先于消息投影：UI 必须先离开空闲态，再渲染续轮内容（与旧编排层顺序一致）。
      awaitingBackgroundWake = false
      await callbacks.onEvent({
        type: 'host_event',
        sessionId: context.sessionId,
        event: { type: 'run_resumed', sessionId: context.sessionId },
      })
    }
    await callbacks.onMessage?.(message)
  }
  if (signal.aborted) return { status: 'stopped' }
  const result = terminalResult as ({ subtype?: unknown; errors?: unknown } | undefined)
  const subtype = typeof result?.subtype === 'string' ? result.subtype : undefined
  const errors = Array.isArray(result?.errors) ? result.errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
  if (subtype !== undefined && subtype !== 'success') {
    return { status: 'failed', error: errors.join('\\n') || `Agent stream ended with ${subtype}` }
  }
  return { status: 'completed' }
}
export interface AgentRuntimeCoordinatorOptions {
  adapters: Partial<Record<AgentRuntime, AgentRuntimeAdapter>>
  ports?: AgentRuntimePorts
  retry?: RetryPolicy & { shouldRetry?: (error: string) => boolean }
  now?: () => number
  /**
   * 共享执行权登记表。宿主把同一个实例同时注入新旧两条执行链即可获得跨引擎互斥；
   * 不注入时 coordinator 自建一份（只在本协调器内互斥，与改造前等价）。
   */
  ownership?: AgentRunOwnershipRegistry
}


/** coordinator 自己的 owner 控制表：执行权归 registry，stop/wait 路由归这里。 */
interface AgentRunControlEntry {
  token: AgentRunOwnershipToken
  /** 已经进入停止流程（stop() 已调用、run 尚未 settle）；只影响拒绝文案。 */
  stopping: boolean
  stop(reason: string): Promise<void>
  wait?: Promise<AgentRunOutcome>
}


export interface AgentRuntimeRunHandle {
  readonly sessionId: string
  readonly runtime: AgentRuntime
  readonly promise: Promise<AgentRunOutcome>
  stop(reason?: string): Promise<void>
}

/**
 * Host-neutral run coordinator. Ownership is claimed synchronously before the
 * first provider await; session persistence and event projection remain ports.
 */
export class AgentRuntimeCoordinator {
  private readonly active = new Map<string, AgentRunControlEntry>()
  private readonly now: () => number
  /** 单一执行权登记表；默认实例只服务本协调器。 */
  readonly ownership: AgentRunOwnershipRegistry

  constructor(private readonly options: AgentRuntimeCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.ownership = options.ownership ?? createAgentRunOwnershipRegistry({ now: this.now })
  }

  run(input: AgentRuntimeQuery, callbacks: AgentRuntimeCallbacks = { onEvent() {} }): AgentRuntimeRunHandle {
    const adapter = this.options.adapters[input.runtime]
    if (!adapter) {
      const promise = Promise.resolve<AgentRunOutcome>({ status: 'failed', error: `${input.runtime} runtime unavailable` })
      return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
    }

    const session = this.options.ports?.sessions
    // 嵌套入口（runAgentHeadless → runtime 入口）会把上层已持有的 token 传下来；
    // 同一 token 的 claim 是幂等的，不会把自己当成并发请求拒绝。
    const token: AgentRunOwnershipToken = input.ownershipToken ?? Symbol(`runtime-run:${input.sessionId}`)
    const claim = this.ownership.claim({ sessionId: input.sessionId, runtime: input.runtime, token })
    if (!claim.ok) {
      // 被拒绝的请求不是一次运行：不落盘、不发事件、不产生 failed 伪终态，也不清理 owner。
      const stopping = this.active.get(input.sessionId)?.stopping === true
      const promise = Promise.reject<AgentRunOutcome>(createAgentRunRejectionError(claim, { stopping }))
      return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
    }

    // 核心独立保证 mismatch 不变量：SessionPort 未提供可选 lockRuntime 时，仍按会话元数据拒绝跨内核请求。
    // 提供 lockRuntime 时由端口判定（端口自身必须在写盘前抛 mismatch），避免把判定权交给 Electron 包装层。
    const boundRuntime = session?.getMeta(input.sessionId)?.agentRuntime
    if (session && !session.lockRuntime && boundRuntime !== undefined && normalizeAgentRuntime(boundRuntime) !== input.runtime) {
      this.ownership.release(input.sessionId, token)
      const promise = Promise.reject<AgentRunOutcome>(
        new AgentSessionRuntimeMismatchError(normalizeAgentRuntime(boundRuntime), input.runtime),
      )
      return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
    }

    const controller = new AbortController()

    // lockRuntime must happen before any async credential/provider work.
    try {
      session?.lockRuntime?.(input.sessionId, input.runtime)
    } catch (error) {
      this.ownership.release(input.sessionId, token)
      const promise = Promise.reject<AgentRunOutcome>(error)
      return { sessionId: input.sessionId, runtime: input.runtime, promise, stop: async () => {} }
    }

    const reporter = createAgentRunOutcomeReporter()
    let providerAttemptActive = false
    let finished = false
    const stop = async (reason: string): Promise<void> => {
      if (finished || this.active.get(input.sessionId)?.token !== token || controller.signal.aborted) return
      const control = this.active.get(input.sessionId)
      if (control) control.stopping = true
      reporter.onComplete({ stoppedByUser: true, endReason: reason })
      controller.abort(reason)
      if (providerAttemptActive) await adapter.stop?.(reason, input.sessionId)
    }
    this.active.set(input.sessionId, { token, stopping: false, stop })
    const abort = () => {
      // EventTarget 不等待 async listener；停止失败记录为执行错误，避免未处理 rejection。
      stop(String(input.abortSignal?.reason ?? 'stopped_by_user')).catch(error => {
        reporter.onError(error instanceof Error ? error.message : String(error))
      })
    }
    if (input.abortSignal?.aborted) abort()
    else input.abortSignal?.addEventListener('abort', abort, { once: true })
    const startedAt = typeof input.metadata?.startedAt === 'number' && Number.isFinite(input.metadata.startedAt)
      ? input.metadata.startedAt
      : this.now()
    const emit = (event: AgentRuntimeEvent): void | Promise<void> => this.options.ports?.host?.emit(event)
    const runCallbacks: AgentRuntimeCallbacks = {
      onEvent: async (event) => {
        if (finished) return
        await emit(event)
        await callbacks.onEvent(event)
      },
      onMessage: async (message: SDKMessage) => {
        if (finished) return
        const runtimeMessage = addRuntimeDuration(message, startedAt, this.now())
        if (isPersistableRuntimeMessage(runtimeMessage)) {
          session?.appendMessages(input.sessionId, [normalizeRuntimeMessage(runtimeMessage, input.modelId, this.now())])
        }
        // 路由键用本轮 run 的 agent 会话 id（`input.sessionId`），不能用 `runtimeMessage.session_id`：
        // 后者是内核原生会话 id，宿主 EventBus 转发层按 agent 会话 id 找绑定 webContents。
        await emit({ type: 'message', sessionId: input.sessionId, message: runtimeMessage })
        await callbacks.onMessage?.(runtimeMessage)
      },
      onError: async () => {
        // provider 的中间错误只由 retry loop 判断；最终 outcome 统一回调宿主。
      },
      onComplete: async () => {
        // provider 的中间终态只由 retry loop 判断；最终 outcome 统一回调宿主。
      },
      onBackgroundTasksPending: async (signal) => {
        // 轻量完成不是终态：只转发给宿主投影，不参与 outcome 判定。
        if (finished) return
        await callbacks.onBackgroundTasksPending?.(signal)
      },
    }

    const rawPromise = (async (): Promise<AgentRunOutcome> => {
      // claim/active 与「provider 真正启动」是两件事：先只声明执行权已被本轮 run 取得。
      // 凭证 / 资源 / 工具装配可能失败，此时 provider 从未参与，宿主不得据此清未读、晋升 draft
      // 或建立 UI running 态（那些副作用统一挂在下面的 `runtime_started` 上）。
      await emit({ type: 'runtime_claimed', sessionId: input.sessionId, runtime: input.runtime, startedAt, title: input.title, workspaceId: input.workspaceId, modelId: input.modelId, initiator: input.initiator })
      if (controller.signal.aborted) return { status: 'stopped' }
      let retryCount = 0
      let retryWaitedMs = 0
      /** provider 启动语义（`runtime_started` + `onRunStarted`）每次 run 只投递一次：重试不重复宣告。 */
      let providerStarted = false
      /** 用户消息每次 run 至多落盘一次：重试只重做准备与 provider attempt，不重复写 transcript。 */
      let userMessagePersisted = false
      while (true) {
        if (controller.signal.aborted) return { status: 'stopped' }
        const preparation = this.options.ports?.queryPreparation
        const preparedContext = preparation
          ? await preparation.prepare(input, controller.signal)
          : (await this.prepare(input, controller.signal)).prepared ?? {}
        if (controller.signal.aborted) return { status: 'stopped' }
        const providerInput = this.options.ports?.providerQueryPreparation
          ? await this.options.ports.providerQueryPreparation.prepare(input, preparedContext, controller.signal)
          : input.providerInput
        const prepared = { ...input, abortSignal: controller.signal, prepared: { ...input.prepared, ...preparedContext }, ...(providerInput ? { providerInput } : {}) }
        if (controller.signal.aborted) return { status: 'stopped' }
        // 用户消息落盘时机（与旧路径同序）：凭证/资源/装配全部准备成功之后、provider 启动之前。
        // 理由：① 凭证失败不留下「孤儿用户气泡」；② 落盘失败也不会启动 provider；
        // ③ 重试命中同一份 transcript，不重复 append。
        // 该落盘仍在第一个 provider await 之前完成，因此持久化失败不会产生半轮运行。
        if (input.persistedUserMessage && !userMessagePersisted) {
          if (!session) throw new AgentRuntimePreparationError('Persisted user message requires a SessionPort', 'session_port_missing', 'persistence')
          session.appendMessages(input.sessionId, [input.persistedUserMessage])
          userMessagePersisted = true
          // 用户气泡也是事件流的一部分：桌面渲染层有乐观气泡并按 uuid 去重，
          // 且不消费 user 文本事件；但 Pocket 没有本地状态，只能靠这条事件在运行中
          // 看到电脑端发起的那句话。缺了它，手机端整轮只剩回复、看不到指令。
          // 必须在 provider 启动前投递，保证移动端先看到用户输入再看到输出。
          await emit({ type: 'message', sessionId: input.sessionId, message: input.persistedUserMessage })
        }
        if (!providerStarted) {
          // 「真正运行开始」的唯一触发点：准备已经成功，provider 随即启动。
          providerStarted = true
          await emit({ type: 'runtime_started', sessionId: input.sessionId, runtime: input.runtime, startedAt, title: input.title, workspaceId: input.workspaceId, modelId: input.modelId, initiator: input.initiator })
          await callbacks.onRunStarted?.({ startedAt })
          if (controller.signal.aborted) return { status: 'stopped' }
        }
        providerAttemptActive = true
        let outcome: AgentRunOutcome
        try {
          outcome = await (adapter.stream
            ? consumeRuntimeStream(adapter.stream(prepared), controller.signal, runCallbacks, {
                sessionId: input.sessionId,
                startedAt,
              })
            : adapter.query(prepared, runCallbacks))
        } catch (error) {
          outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
        } finally {
          providerAttemptActive = false
        }
        if (outcome.status !== 'failed' || controller.signal.aborted) return controller.signal.aborted ? { status: 'stopped' } : outcome

        const shouldRetry = this.options.retry?.shouldRetry ?? ((error: string) => isRetryableError({ message: error }))
        const policy: RetryPolicy = { ...this.options.retry, maxRetries: this.options.retry?.maxRetries ?? 0 }
        if (!shouldRetry(outcome.error) || !canRetry(retryCount + 1, retryWaitedMs, policy)) return outcome
        retryCount += 1
        const delayMs = getRetryDelayMs(retryCount, retryWaitedMs, policy)
        await runCallbacks.onEvent({ type: 'retry', attempt: retryCount, delayMs, reason: outcome.error })
        if (await waitForRetryDelay(delayMs, { signal: controller.signal }) === 'stopped') return { status: 'stopped' }
        retryWaitedMs += delayMs
      }
    })()
      .then(async (outcome) => {
        if (outcome.status === 'completed') reporter.onComplete()
        else if (outcome.status === 'stopped') reporter.onComplete({ stoppedByUser: true })
        else {
          reporter.onError(outcome.error)
          await callbacks.onError?.(outcome.error)
        }
        return reporter.finish() ?? outcome
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        reporter.onError(message)
        // 准备阶段失败（provider 未产生终态）：把结构化失败码交给宿主。
        // 终态仍由 onComplete 统一给出，本回调不替代它、也不产生第二个终态。
        await callbacks.onPreparationFailure?.(preparationFailureFrom(error, message))
        return reporter.finish() ?? ({ status: 'failed', error: message } satisfies AgentRunOutcome)
      })
    let finalOutcome: AgentRunOutcome | undefined
    const promise = rawPromise
      .then(async (outcome) => {
        finalOutcome = outcome
        finished = true
        try {
          await callbacks.onComplete?.(outcome)
        } catch {
          // 终态观察者异常不撤销已经确定的 outcome。
        }
        return outcome
      })
      .finally(async () => {
        input.abortSignal?.removeEventListener('abort', abort)
        // 释放必须校验 token：旧 run 的 finally 不能清掉已被新 run 接管的会话。
        this.ownership.release(input.sessionId, token)
        if (this.active.get(input.sessionId)?.token === token) this.active.delete(input.sessionId)
        try {
          await emit({ type: 'runtime_finished', sessionId: input.sessionId, runtime: input.runtime, outcome: finalOutcome ?? { status: 'failed', error: 'Agent 未产生运行终态' }, finishedAt: this.now(), title: input.title, workspaceId: input.workspaceId, modelId: input.modelId, initiator: input.initiator })
        } catch {
          // 宿主终态投影失败不能使已完成的 run 重新失败；owner 已释放。
        }
      })

    const owner = this.active.get(input.sessionId)
    if (owner?.token === token) owner.wait = promise
    return {
      sessionId: input.sessionId,
      runtime: input.runtime,
      promise,
      stop: async (reason = 'stopped_by_user') => stop(reason),
    }
  }

  private async prepare(input: AgentRuntimeQuery, signal: AbortSignal): Promise<AgentRuntimeQuery> {
    return {
      ...input,
      abortSignal: signal,
      prepared: await createAgentQueryPreparationPort(this.options.ports ?? {}).prepare(input, signal),
    }
  }
  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  async stop(sessionId: string, reason = 'stopped_by_user'): Promise<void> {
    const active = this.active.get(sessionId)
    if (!active) return
    await active.stop(reason)
  }
  async stopAndWait(sessionId: string, reason = 'stopped_by_user'): Promise<void> {
    const active = this.active.get(sessionId)
    if (!active) return
    await active.stop(reason)
    await active.wait
  }

  async stopAll(reason = 'stopped_by_user'): Promise<void> {
    const active = [...this.active.values()]
    await Promise.all(active.map(async owner => {
      await owner.stop(reason)
      await owner.wait
    }))
  }
}

export function createAgentRuntimeCoordinator(options: AgentRuntimeCoordinatorOptions): AgentRuntimeCoordinator {
  return new AgentRuntimeCoordinator(options)
}
