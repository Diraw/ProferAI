/**
 * runtime-migration-parity / 入口级 driver
 *
 * 与 `new-engine.ts`（直接驱动 coordinator）的区别：这里驱动的是**真实生产模块**
 * `agent-runtime-entry.ts` 的 `runRuntimeHeadlessEntry` —— 也就是 `agent-service.ts`
 * 的 runtime headless 入口实际调用的那一段。因此「策略快照是否挂上」「终态是否只投递一次」
 * 「preflight 是否保持旧语义」「计划模式是否投影」这些问题由**行为证据**回答，
 * 不需要在测试里复刻接线，也不需要切片编译 `agent-service.ts`。
 *
 * 依赖注入方式与生产一致：真实 coordinator + 真实宿主端口（`createParityHost`）。
 */

import type {
  AgentRuntimeAdapter,
  AgentRuntimeCallbacks,
  AgentRunOutcome,
} from '@profer/agent-runtime'
import { AgentRuntimeCoordinator } from '@profer/agent-runtime'
import type { AgentExternalRunSource, AgentRunInitiator, AgentRuntime, AgentSendInput } from '@profer/shared'
import { runRuntimeHeadlessEntry, type RuntimeEntryRunContext } from '../../agent-runtime-entry'
import type { AgentRuntimePlanModeEvent } from '../../agent-runtime-plan-mode'
import type { RuntimeTerminalFields } from '../../agent-runtime-terminal-projection'
import type { ParityHostFixture } from './parity-host'
import { recordingAdapter, type NewEngineAdapterInput, type NewEngineRecording } from './new-engine'

export interface EntryDriverOptions {
  host: ParityHostFixture
  adapters: Partial<Record<AgentRuntime, NewEngineAdapterInput>>
  /** 缺省：runtime 取输入（或 pi），无 cwd，工具装配 context 为空，无策略快照。 */
  resolveRunContext?: (input: AgentSendInput) => RuntimeEntryRunContext
  source?: AgentExternalRunSource
  initiator?: AgentRunInitiator
  /** 重试策略（测「重试等待期间取消」需要）。 */
  retry?: ConstructorParameters<typeof AgentRuntimeCoordinator>[0]['retry']
}

export interface EntryObservation {
  outcome: AgentRunOutcome | undefined
  /** 被拒绝时的具名错误（`Name: message`）；undefined 表示本次请求确实运行过。 */
  rejected: string | undefined
  /** `onError` 投递（用户可见文案）。 */
  errors: string[]
  /** 终态字段（唯一一次投递）。 */
  fields: RuntimeTerminalFields | undefined
  /** 全部 `onComplete` 字段序列（含 `backgroundTasksPending` 轻量完成）。 */
  completionFields: RuntimeTerminalFields[]
  /** `onComplete` 投递次数；>1 即「重复终态」。 */
  completions: number
  /** 终态未读策略的调用记录。 */
  unread: Array<{ fields: RuntimeTerminalFields; started: boolean }>
  /** run 真正启动的次数。 */
  runStarted: number
  providerStarts: number
  /** 计划模式投影（同时经 host port 的 host_event 通道发出）。 */
  planEvents: AgentRuntimePlanModeEvent[]
  activeAfter: boolean
}

export interface EntryDriver {
  coordinator: AgentRuntimeCoordinator
  recording: NewEngineRecording
  run(input: AgentSendInput, overrides?: Partial<AgentRuntimeCallbacks>): Promise<EntryObservation>
  /** 启动一轮但不等待（用于取消类用例）。 */
  start(input: AgentSendInput, overrides?: Partial<AgentRuntimeCallbacks>): {
    observation: Promise<EntryObservation>
    stop(reason?: string): Promise<void>
  }
}

export function createEntryDriver(options: EntryDriverOptions): EntryDriver {
  const recording: NewEngineRecording = { providerStarts: 0, providerStops: 0, stopReasons: [] }
  const adapters: Partial<Record<AgentRuntime, AgentRuntimeAdapter>> = {}
  for (const runtime of Object.keys(options.adapters) as AgentRuntime[]) {
    const adapter = options.adapters[runtime]
    if (adapter) adapters[runtime] = recordingAdapter(runtime, adapter, recording)
  }
  const coordinator = new AgentRuntimeCoordinator({
    adapters,
    ports: {
      ...options.host.ports,
      // 入口总是给 query 带 toolAssemblyContext（策略字段就并在这里），因此装配端口必须存在；
      // 生产侧由 `createElectronAgentHost` 无条件注入，driver 默认给一个空装配实现。
      toolAssembly: options.host.ports.toolAssembly
        ?? { build: async () => ({ tools: [], collaborationAvailable: false }) },
    },
    ...(options.retry ? { retry: options.retry } : {}),
  })

  const run = async (
    input: AgentSendInput,
    overrides: Partial<AgentRuntimeCallbacks> = {},
  ): Promise<EntryObservation> => {
    const observation: EntryObservation = {
      outcome: undefined,
      rejected: undefined,
      errors: [],
      fields: undefined,
      completionFields: [],
      completions: 0,
      unread: [],
      runStarted: 0,
      providerStarts: 0,
      planEvents: [],
      activeAfter: false,
    }
    try {
      observation.outcome = await runRuntimeHeadlessEntry(input, { onEvent: () => {}, ...overrides }, {
        ...(options.source !== undefined ? { source: options.source } : {}),
        ...(options.initiator !== undefined ? { initiator: options.initiator } : {}),
        resolveRunContext: options.resolveRunContext
          ?? (sendInput => ({ runtime: sendInput.agentRuntime ?? 'pi', toolAssemblyContext: {} })),
        run: (query, callbacks) => coordinator.run(query, callbacks),
        sessions: options.host.sessions,
        messages: () => options.host.session.agentMessages,
        emitPlanModeEvent: (sessionId, event) => {
          observation.planEvents.push(event)
          // 生产接线：host port 的 host_event 会被 Electron createElectronEventPort 转成 profer_event。
          void options.host.ports.host?.emit({ type: 'host_event', sessionId, event })
        },
        onRunStarted: () => { observation.runStarted += 1 },
        applyCompletionUnread: (_input, fields, started) => { observation.unread.push({ fields, started }) },
        sink: {
          onError: error => observation.errors.push(error),
          onComplete: (_messages, fields) => {
            observation.completions += 1
            observation.fields = fields
            observation.completionFields.push(fields)
          },
        },
      })
    } catch (error) {
      observation.rejected = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    observation.providerStarts = recording.providerStarts
    observation.activeAfter = coordinator.isRunning(input.sessionId)
    return observation
  }

  return {
    coordinator,
    recording,
    run,
    start: (input, overrides = {}) => {
      const observation = run(input, overrides)
      return {
        observation,
        stop: (reason = 'stopped_by_user') => coordinator.stop(input.sessionId, reason),
      }
    },
  }
}
