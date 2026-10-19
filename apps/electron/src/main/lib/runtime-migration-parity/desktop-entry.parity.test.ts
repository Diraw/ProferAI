/**
 * desktop-entry.parity —— 桌面 `runAgent` 走 runtime 链时的投影等价性（本 lane 任务二）
 *
 * 对照方式：**同一次输入、同一份内存宿主 fixture**，分别驱动
 * - 旧链：切片编译的真实 `agent-service.ts: runAgent()` + 真实 `AgentOrchestrator`（`support/old-engine`）；
 * - 新链：本 lane 新增的 `agent-runtime-desktop-entry.ts: runDesktopRuntimeAgent()` + 真实 `AgentRuntimeCoordinator`。
 *
 * 两条链的**宿主侧投影**（事件出口、专用终态 IPC、backlog、未读、草稿晋升、守卫）用**同一组 recorder**
 * 记录，因此断言比较的是可观察行为，而不是测试里复刻的接线。
 *
 * 明确不在本文件覆盖（写成逐条实机验收清单交回）：
 * - 真实 Electron webContents / 真实 JSONL / 真实 provider 传输；
 * - 渲染层实际渲染（审批弹窗、计划横幅、角标、草稿恢复的视觉）；
 * - 桌面通知与提示音。
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import type { AgentRuntimeAdapter, AgentRuntimeCallbacks, AgentRuntimeQuery } from '@profer/agent-runtime'
import { AgentRuntimeCoordinator, createAgentRunOwnershipRegistry } from '@profer/agent-runtime'
import { AgentEventBus } from '../agent-event-bus'
import type {
  AgentRunInitiator,
  AgentSendInput,
  AgentSessionMeta,
  AgentStreamPayload,
  SDKMessage,
} from '@profer/shared'
import { AGENT_IPC_CHANNELS, AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError, resolveRunInitiator } from '@profer/shared'
import type { AgentGenerateTitleInput } from '@profer/shared'
import { DEFAULT_SESSION_TITLE } from '../agent-prompt-utils'
import type { AgentRuntimePolicyResolutionInput } from '../agent-runtime-policy-snapshot'
import { AgentRuntimeContextStore } from '../agent-runtime-context'
import { buildAgentSessionUiProjection } from '../agent-session-ui-projection'
import type { AgentRuntimePlanModeEvent } from '../agent-runtime-plan-mode'
import type { DesktopRuntimeAgentHost, DesktopRuntimeSender } from '../agent-runtime-desktop-entry'
import { runDesktopRuntimeAgent } from '../agent-runtime-desktop-entry'
import { DESKTOP_RUNTIME_SWITCH_ENV, resolveDesktopRunChain } from '../agent-runtime-desktop-switch'
import { createElectronEventPort } from '../agent-runtime-host'
import { createElectronProviderQueryPreparation } from '../agent-runtime-provider-preparation'
import { createAgentRunOutcomeReporter } from '../agent-run-outcome'
import type { AgentUnreadPolicyMode } from '../agent-unread-policy'
import { shouldClearSessionUnreadOnRunStart, shouldMarkSessionUnreadOnCompletion } from '../agent-unread-policy'
import { compileSlice, countOccurrences, readMainSource, sliceBetween } from './support/compile-slice'
import { createOldEngine, type OldEngineDriver } from './support/old-engine'
import { createParityHost, type ParityHostFixture } from './support/parity-host'

// ============================================================================
// 1. 开关（默认关闭，显式 1 启用）
// ============================================================================

describe('桌面 runtime 开关（默认关闭，显式 1 启用）', () => {
  const plainInput: Pick<AgentSendInput, 'goalRunId' | 'reportGoalResult' | 'onRuntimeSessionId' | 'onRuntimeMessage'> = {}

  test('默认关闭：未设置 / 0 / 其他值都走旧链，显式 1 才走新链', () => {
    expect(DESKTOP_RUNTIME_SWITCH_ENV).toBe('PROFER_RUNTIME_DESKTOP')
    expect(resolveDesktopRunChain(plainInput, {})).toBe('orchestrator')
    expect(resolveDesktopRunChain(plainInput, { [DESKTOP_RUNTIME_SWITCH_ENV]: '1' })).toBe('runtime')
    expect(resolveDesktopRunChain(plainInput, { [DESKTOP_RUNTIME_SWITCH_ENV]: 'true' })).toBe('orchestrator')
    expect(resolveDesktopRunChain(plainInput, { [DESKTOP_RUNTIME_SWITCH_ENV]: '0' })).toBe('orchestrator')
  })

  test('Goal 输入即使开关打开也回旧链（GAP-6 未关闭，与 canUseRuntimeHeadless 同组排除）', () => {
    const on = { [DESKTOP_RUNTIME_SWITCH_ENV]: '1' }
    expect(resolveDesktopRunChain({ goalRunId: 'goal-1' }, on)).toBe('orchestrator')
    expect(resolveDesktopRunChain({ reportGoalResult: () => undefined }, on)).toBe('orchestrator')
    expect(resolveDesktopRunChain({ onRuntimeSessionId: () => undefined }, on)).toBe('orchestrator')
    expect(resolveDesktopRunChain({ onRuntimeMessage: () => undefined }, on)).toBe('orchestrator')
  })

  test('开关读取点唯一：桌面开关模块读一次，runAgent 经判定函数接线（默认关闭）', () => {
    const switchSource = readMainSource('agent-runtime-desktop-switch.ts')
    expect(countOccurrences(switchSource, DESKTOP_RUNTIME_SWITCH_ENV)).toBe(1)

    // 已接线（IR-D1）：runAgent 在任何 await 之前经 `resolveDesktopRunChain` 判定一次；默认关闭。
    // 默认关闭态走旧链；显式启用态才走 runtime；环境变量的唯一读取点仍在桌面开关模块，IPC 不自读。
    const agentServiceSource = readMainSource('agent-service.ts')
    const runAgentSlice = sliceBetween(
      agentServiceSource,
      'export async function runAgent(',
      '/**\n * 直接使用 runtime coordinator 的 headless 入口',
      'runAgent',
    )
    expect(countOccurrences(runAgentSlice, 'resolveDesktopRunChain(')).toBe(1)
    expect(countOccurrences(runAgentSlice, 'runDesktopRuntimeAgent(')).toBe(1)
    expect(countOccurrences(runAgentSlice, DESKTOP_RUNTIME_SWITCH_ENV)).toBe(0)
    expect(countOccurrences(readMainSource('../ipc.ts'), DESKTOP_RUNTIME_SWITCH_ENV)).toBe(0)
  })
})

// ============================================================================
// 2. 桌面投影 recorder + 两条链的 driver
// ============================================================================

/** 两条链共用的宿主侧投影记录器（比较的就是它）。 */
interface DesktopProjectionRecorder {
  /** 事件出口（eventBus）上出现的 payload，按顺序 —— 等价于刷新回放的窗口内容。 */
  payloads: AgentStreamPayload[]
  /** 专用 IPC 直发（STREAM_ERROR / STREAM_COMPLETE / TITLE_UPDATED）。 */
  sends: Array<{ channel: string; payload: Record<string, unknown> }>
  /** 请求入口清未读（旧链位置，仅 auto 模式生效）。 */
  entryUnreadClears: string[]
  /** run 起点清未读的判定（含模式）。 */
  runStartUnread: Array<{ initiator: AgentRunInitiator; mode: AgentUnreadPolicyMode; decision: boolean }>
  /** 终态未读的判定（含模式）。 */
  completionUnread: Array<{
    initiator: AgentRunInitiator
    mode: AgentUnreadPolicyMode
    backgroundTasksPending?: boolean
    started: boolean
    decision: boolean
  }>
  /** draft 晋升（写 meta 的调用）。 */
  promotions: Array<{ sessionId: string; promoted: boolean }>
  /** 草稿晋升后的宿主回调（飞书镜像）。 */
  draftPromotedCallbacks: string[]
  /** 会话投影广播次数。 */
  projections: string[]
  /** backlog 生命周期。 */
  backlogBegin: number
  backlogFinish: number
  /** 最后一次 finish 时的窗口快照（刷新回放要重放的东西）。 */
  replayed: AgentStreamPayload[]
  /**
   * GAP-D1：**新链**自动命名窗口实际发起的生成调用（旧链由用例 spy `generateTitle` 记录）。
   * 比较它对标的是「同一次输入下两条链是否用同一份来源、同一渠道/模型调生成」。
   */
  titleGenerations: AgentGenerateTitleInput[]
}

function emptyRecorder(): DesktopProjectionRecorder {
  return {
    payloads: [],
    sends: [],
    entryUnreadClears: [],
    runStartUnread: [],
    completionUnread: [],
    promotions: [],
    draftPromotedCallbacks: [],
    projections: [],
    backlogBegin: 0,
    backlogFinish: 0,
    replayed: [],
    titleGenerations: [],
  }
}

const isBacklogPayload = (payload: AgentStreamPayload): boolean =>
  payload.kind !== 'session_projection' && payload.kind !== 'catalog_invalidation'

/** 事件出口上「会被 backlog 记录」的 payload（与 agent-service 的中间件规则同源）。 */
function backlogKinds(recorder: DesktopProjectionRecorder): string[] {
  return recorder.payloads.filter(isBacklogPayload).map(describePayload)
}

function describePayload(payload: AgentStreamPayload): string {
  if (payload.kind === 'profer_event') return `profer_event:${payload.event.type}`
  return payload.kind
}

interface DesktopChainHarness {
  host: ParityHostFixture
  recorder: DesktopProjectionRecorder
  coordinator: AgentRuntimeCoordinator
  old: OldEngineDriver
  /** 旧链（真实切片 `runAgent` + 真实 orchestrator）。 */
  runOld(input?: AgentSendInput): Promise<{ rejected?: string }>
  startOld(input?: AgentSendInput): { done: Promise<{ rejected?: string }>; stop(): Promise<void> }
  /** 新链（真实 `runDesktopRuntimeAgent` + 真实 coordinator）。 */
  runNew(input?: AgentSendInput): Promise<{ rejected?: string }>
  startNew(input?: AgentSendInput): { done: Promise<{ rejected?: string }>; stop(): Promise<void> }
  /** 两条链共享的 host 侧 recorder 快照（用于跨链比较）。 */
  snapshot(): DesktopProjectionRecorder
}

interface DesktopChainOptions {
  mode?: AgentUnreadPolicyMode
  /** provider 流（两条链共用同一工厂；只依赖 `abortSignal`，与两侧 query 形状无关）。 */
  stream?: (query: { abortSignal?: AbortSignal }) => AsyncGenerator<SDKMessage>
  /** 删除 / 分叉守卫注入；缺省放行。 */
  guard?: (sessionId: string) => string | undefined
  /** 新链的本轮策略上下文（计划模式 / 权限模式断言用）。 */
  policy?: AgentRuntimePolicyResolutionInput
  /** 共享执行权登记表（互斥用例用；缺省每条链自己新建）。 */
  ownership?: ReturnType<typeof createAgentRunOwnershipRegistry>
  /** 初始会话元数据（draft 用例用）。 */
  meta?: AgentSessionMeta
  /**
   * GAP-D1：新链的自动命名窗口（生成器替身 + 两个常量）。
   *
   * 缺省不提供 `titleNaming` —— 此时新链不产生任何标题事件（与旧链无关的路由差异用例不受影响）。
   * 投影与生产同形：`profer_event: title_updated` 走事件出口，`TITLE_UPDATED` 走专用 IPC。
   */
  titleNaming?: {
    generate(input: AgentGenerateTitleInput): Promise<string | null>
    defaultTitle?: string
    defaultModelId?: string
  }
}

const defaultResultStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
  yield { type: 'result', subtype: 'success', session_id: 'parity-session' } as unknown as SDKMessage
})()

/** 持续产出但不结束的流：用于「持有执行权」的并发 / 取消用例（可被 `iterator.return()` 关闭）。 */
const keepAliveStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
  yield { type: 'assistant', session_id: 'parity-session', message: { content: [{ type: 'text', text: 'holding' }] }, parent_tool_use_id: null } as unknown as SDKMessage
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 20))
    yield { type: 'system', subtype: 'thinking_tokens', session_id: 'parity-session' } as unknown as SDKMessage
  }
})()

const defaultInput = (extra: Record<string, unknown> = {}): AgentSendInput => ({
  sessionId: 'parity-session',
  channelId: 'parity-channel',
  userMessage: 'hello',
  agentRuntime: 'pi' as const,
  ...extra,
})

/** 切片编译的真实 `runAgent`（唯一改动：依赖由参数注入）。 */
const agentServiceSource = readMainSource('agent-service.ts')

/** 读取渲染层源码文本（只读断言，不 import 渲染层模块 —— 保持 main → renderer 的边界干净）。 */
function readRendererSource(relativePath: string): string {
  return readFileSync(new URL(`../../../renderer/${relativePath}`, import.meta.url), 'utf8')
}

/** 递归读取一个目录下的源码（跳过 node_modules / dist / 隐藏目录）。 */
function walkSources(root: URL): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const visit = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const child = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`
      if (entry.isDirectory()) visit(child)
      else if (/\.tsx?$/.test(entry.name)) out.push({ path: child, text: readFileSync(child, 'utf8') })
    }
  }
  visit(root.pathname)
  return out
}

/** 桌面新链相对旧链多 / 少的 payload 类型（已逐条取证为渲染层 inert）。 */
const DESKTOP_CHAIN_ONLY_KINDS = [
  'profer_event:external_run_started',
  'profer_event:run_completed',
  'profer_event:run_idle',
]
const runAgentSource = sliceBetween(
  agentServiceSource,
  'export async function runAgent(',
  '/**\n * 直接使用 runtime coordinator 的 headless 入口',
  'runAgent',
)

/**
 * 切片编译的真实 backlog + 刷新回放入口。
 *
 * 切片覆盖 `sessionWebContents` → `restoreActiveAgentStreams`，并且**包含三条 eventBus 中间件**
 * （其中一条就是「把 payload 记入本轮 backlog」）——因此下面的重放走的是生产代码路径：
 * `eventBus.emit(payload)` → 中间件记录 → `restoreActiveAgentStreams` 回放。
 */
const backlogSource = sliceBetween(
  agentServiceSource,
  'const sessionWebContents = new Map<string, WebContents>()',
  '// ===== 统一事件出口 =====',
  'desktop-backlog',
)

interface CompiledBacklog {
  begin(sessionId: string): void
  finish(sessionId: string): void
  restore(wc: unknown): Array<{ sessionId: string; active: boolean; hasTerminalEvent: boolean }>
}

function compileBacklog(options: {
  isActive: (sessionId: string) => boolean
  messages: (sessionId: string) => unknown[]
}): { compiled: CompiledBacklog; eventBus: AgentEventBus } {
  const eventBus = new AgentEventBus()
  const compiled = compileSlice<CompiledBacklog>(
    backlogSource,
    '{ begin: beginActiveStreamBacklog, finish: finishActiveStreamBacklog, restore: restoreActiveAgentStreams }',
    {
      // 只注入切片里引用的模块级符号；漏注入会在运行到该行时以 ReferenceError 暴露。
      runtimeContextStore: new AgentRuntimeContextStore(),
      getAgentSessionMessages: (sessionId: string) => options.messages(sessionId),
      AGENT_IPC_CHANNELS,
      eventBus,
      BrowserWindow: { getAllWindows: () => [] },
      orchestrator: { isActive: () => false },
      runtimeCoordinator: { isRunning: () => false },
      registerWebContents: () => {},
      unregisterWebContents: () => {},
    },
  )
  return { compiled, eventBus }
}

/**
 * 建一条可比较的桌面链：同一份 fixture 上同时具备旧链 driver 与新链 driver，
 * 但**只有被调用的那一条**会产生副作用。
 */
function createDesktopChain(options: DesktopChainOptions = {}): DesktopChainHarness {
  const recorder = emptyRecorder()
  const mode: AgentUnreadPolicyMode = options.mode ?? 'auto'
  const streamFactory = options.stream ?? defaultResultStream
  const host = createParityHost({
    runtime: 'pi',
    ...(options.meta ? { meta: options.meta } : {}),
    providerQueryPreparation: createElectronProviderQueryPreparation(),
    toolAssembly: { build: async () => ({ tools: [], collaborationAvailable: false }) },
  })

  // 旧链的事件出口：orchestrator 的 events 端口与 agent-service 的 eventBus 都指向同一记录器。
  const recordPayload = (payload: AgentStreamPayload): void => { recorder.payloads.push(payload) }
  host.ports.events!.emit = (_sessionId, payload) => recordPayload(payload)
  host.legacyEventBus.emit = (_sessionId, payload) => recordPayload(payload)

  const ownership = options.ownership ?? createAgentRunOwnershipRegistry()
  const old = createOldEngine({
    host,
    input: defaultInput(),
    ownership,
    adapter: { query: options => streamFactory(options as unknown as AgentRuntimeQuery) },
  })

  // 新链：coordinator 的 host 事件端口用**真实** createElectronEventPort + 真实 AgentEventBus，
  // 出口同样是记录器。计划模式事件也走同一个端口（与生产一致：host_event → profer_event）。
  const runtimeEventBus = new AgentEventBus()
  runtimeEventBus.on((_sid, payload) => recordPayload(payload))
  const hostEventPort = createElectronEventPort(runtimeEventBus)
  const coordinator = new AgentRuntimeCoordinator({
    adapters: { pi: { runtime: 'pi', stream: (query: AgentRuntimeQuery) => streamFactory(query) } as unknown as AgentRuntimeAdapter },
    ports: { ...host.ports, host: hostEventPort },
    ownership,
  })
  const sender: DesktopRuntimeSender & { isDestroyed(): boolean } = {
    send: (channel, payload) => { recorder.sends.push({ channel, payload: payload as Record<string, unknown> }) },
    isDestroyed: () => false,
  }
  const sessionWebContents = new Map<string, unknown>()
  const sessionId = 'parity-session'
  const isNewActive = (): boolean => coordinator.isRunning(sessionId)
  const isOldActive = (): boolean => old.instance.isActive(sessionId)

  // ---- 未读 / 草稿：两条链共用同一组 recorder，且都走**真实纯函数策略** ----
  const recordEntryUnreadClear = (sid: string): void => {
    recorder.entryUnreadClears.push(sid)
    if (mode !== 'auto') return
    // 关闭态：原实现无条件写 false（这里只记录判定，不碰真实设置）。
  }
  const recordRunStartUnread = (sid: string, initiator: AgentRunInitiator): void => {
    const decision = mode === 'auto' ? false : shouldClearSessionUnreadOnRunStart(initiator, mode)
    recorder.runStartUnread.push({ initiator, mode, decision })
    void sid
  }
  const recordCompletionUnread = (args: {
    sessionId: string
    initiator: AgentRunInitiator
    backgroundTasksPending?: boolean
    started: boolean
  }): void => {
    const decision = shouldMarkSessionUnreadOnCompletion({
      initiator: args.initiator,
      delegationDepth: host.session.meta?.delegationDepth,
      backgroundTasksPending: args.backgroundTasksPending,
      started: args.started,
    }, mode)
    recorder.completionUnread.push({
      initiator: args.initiator,
      mode,
      ...(args.backgroundTasksPending !== undefined ? { backgroundTasksPending: args.backgroundTasksPending } : {}),
      started: args.started,
      decision,
    })
  }
  const promoteDraft = (sid: string): { session: AgentSessionMeta | undefined; promoted: boolean } => {
    const before = host.session.meta
    const promoted = before?.draft === true
    const session = promoted ? { ...(before as AgentSessionMeta), draft: false } : before
    if (promoted && session) host.sessions.updateMeta(sid, { draft: false })
    recorder.promotions.push({ sessionId: sid, promoted })
    return { session, promoted }
  }
  const publishProjection = (session: AgentSessionMeta): void => {
    recorder.projections.push(session.id)
    recordPayload({ kind: 'session_projection', operation: 'upsert', session: buildAgentSessionUiProjection(session) })
  }
  const checkGuards = (sid: string): string | undefined => options.guard?.(sid)

  // ---- 新链 driver ----
  const newHost: DesktopRuntimeAgentHost = {
    sender,
    registerWebContents: (sid, wc) => { sessionWebContents.set(sid, wc) },
    isExecutionActive: () => isNewActive() || isOldActive(),
    beginActiveStreamBacklog: () => {
      if (isNewActive() || isOldActive()) return
      recorder.backlogBegin += 1
    },
    finishActiveStreamBacklog: () => {
      if (isNewActive() || isOldActive()) return
      recorder.backlogFinish += 1
      recorder.replayed = recorder.payloads.filter(isBacklogPayload)
    },
    emit: (_sid, payload) => recordPayload(payload),
    clearUnreadOnRequestEntry: recordEntryUnreadClear,
    applyRunStartUnreadPolicy: recordRunStartUnread,
    applyCompletionUnreadPolicy: recordCompletionUnread,
    getSessionMeta: () => host.session.meta,
    promoteDraftSession: promoteDraft,
    publishSessionProjection: publishProjection,
    checkEntryGuards: checkGuards,
    onDraftPromoted: session => { recorder.draftPromotedCallbacks.push(session.id) },
    // GAP-D1：与 `agent-service.ts` 的 `buildRuntimeTitleNaming` 同形的宿主观测（真实投影
    // 在宿主入口，这里只把同一事件类型/字段送进同一组 recorder，使两链可比）。
    ...(options.titleNaming
      ? {
          titleNaming: {
            generate: (titleInput: AgentGenerateTitleInput) => {
              recorder.titleGenerations.push(titleInput)
              return options.titleNaming!.generate(titleInput)
            },
            onTitleUpdated: (title: string) => {
              recordPayload({ kind: 'profer_event', event: { type: 'title_updated', title } })
              recorder.sends.push({
                channel: AGENT_IPC_CHANNELS.TITLE_UPDATED,
                payload: { sessionId, title },
              })
            },
            defaultTitle: options.titleNaming.defaultTitle ?? DEFAULT_SESSION_TITLE,
            defaultModelId: options.titleNaming.defaultModelId ?? 'parity-model',
          },
        }
      : {}),
    resolveRunContext: sendInput => ({
      runtime: 'pi',
      cwd: '/tmp/parity-cwd',
      toolAssemblyContext: { sessionId: sendInput.sessionId, channelId: sendInput.channelId },
      ...(options.policy ? { policy: options.policy } : {}),
    }),
    run: (query, callbacks: AgentRuntimeCallbacks) => coordinator.run(query, callbacks),
    sessions: host.sessions,
    messages: () => host.session.agentMessages,
    emitPlanModeEvent: (_sid, event: AgentRuntimePlanModeEvent) => {
      // 生产接线：host port 的 host_event 会被 Electron createElectronEventPort 转成 profer_event。
      hostEventPort.emit({ type: 'host_event', sessionId, event })
    },
  }

  // ---- 旧链 driver：切片编译的真实 runAgent ----
  const compiledRunAgent = compileSlice<(input: AgentSendInput, wc: unknown, onDraftPromoted?: (s: AgentSessionMeta) => void | Promise<void>) => Promise<void>>(
    runAgentSource,
    'runAgent',
    {
      registerWebContents: (sid: string, wc: unknown) => { sessionWebContents.set(sid, wc) },
      // 旧链 driver 固定走旧分支（真实 dispatch 由入口路由 parity 覆盖）。
      // 但切片里仍会引用桌面分支的两个符号：注入替身（本 driver 不会走到），
      // 避免以后把这里的判定改成 'runtime' 时撞上未注入符号的 ReferenceError。
      resolveDesktopRunChain: () => 'orchestrator' as const,
      buildRuntimeTitleNaming: () => undefined,
      isAgentExecutionActive: () => isOldActive() || isNewActive(),
      beginActiveStreamBacklog: () => {
        if (isOldActive() || isNewActive()) return
        recorder.backlogBegin += 1
      },
      finishActiveStreamBacklog: () => {
        if (isOldActive() || isNewActive()) return
        recorder.backlogFinish += 1
        recorder.replayed = recorder.payloads.filter(isBacklogPayload)
      },
      resolveInputInitiator: (input: AgentSendInput) => input.initiator ?? resolveRunInitiator(input.triggeredBy, undefined),
      clearSessionUnreadOnRequestEntry: recordEntryUnreadClear,
      createAgentRunOutcomeReporter,
      orchestrator: old.instance,
      eventBus: { emit: (_sid: string, payload: AgentStreamPayload) => recordPayload(payload) },
      sessionWebContents,
      AGENT_IPC_CHANNELS,
      applyCompletionUnreadPolicy: recordCompletionUnread,
      applyRunStartUnreadPolicy: recordRunStartUnread,
      getAgentSessionMeta: () => host.session.meta,
      updateAgentSessionMeta: (sid: string, patch: Partial<AgentSessionMeta>) => {
        const before = host.session.meta
        host.sessions.updateMeta(sid, patch)
        // 旧链的 draft 晋升发生在这里（`{ draft: false }`），与旧链 `onRunStarted` 同序。
        if (patch.draft === false) recorder.promotions.push({ sessionId: sid, promoted: before?.draft === true })
        return host.session.meta
      },
      publishAgentSessionProjection: publishProjection,
      AgentRunAlreadyActiveError,
      AgentSessionRuntimeMismatchError,
      serializeErrorDetail: (error: unknown) => String(error),
    },
  )

  const wrap = async (promise: Promise<void>): Promise<{ rejected?: string }> => {
    try {
      await promise
      return {}
    } catch (error) {
      return { rejected: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    }
  }

  return {
    host,
    recorder,
    coordinator,
    old,
    runOld: (input = defaultInput()) => wrap(compiledRunAgent(input, sender, session => { recorder.draftPromotedCallbacks.push(session.id) })),
    startOld: (input = defaultInput()) => {
      const done = wrap(compiledRunAgent(input, sender, session => { recorder.draftPromotedCallbacks.push(session.id) }))
      return { done, stop: async () => { old.instance.stop(input.sessionId) } }
    },
    runNew: (input = defaultInput()) => wrap(runDesktopRuntimeAgent(input, newHost)),
    startNew: (input = defaultInput()) => {
      const done = wrap(runDesktopRuntimeAgent(input, newHost))
      return { done, stop: async () => { await coordinator.stop(input.sessionId, 'stopped_by_user') } }
    },
    snapshot: () => ({ ...recorder, payloads: [...recorder.payloads], sends: [...recorder.sends] }),
  }
}

// ============================================================================
// 3. 终态与事件出口等价
// ============================================================================

describe('终态投影与事件出口等价（真实旧 runAgent vs 新桌面入口）', () => {
  test('同一轮成功运行：终态字段集、专用 IPC、落盘顺序三条链一致', async () => {
    const old = createDesktopChain()
    const next = createDesktopChain()

    await old.runOld()
    await next.runNew()

    const oldSends = old.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
    const newSends = next.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
    expect(oldSends).toHaveLength(1)
    expect(newSends).toHaveLength(1)
    expect(oldSends[0]?.payload).toMatchObject({
      sessionId: 'parity-session',
      stoppedByUser: false,
      endReason: 'completed',
      initiator: 'user',
    })
    expect(newSends[0]?.payload).toMatchObject({
      sessionId: 'parity-session',
      stoppedByUser: false,
      endReason: 'completed',
      initiator: 'user',
    })
    // 终态字段集逐键相等（键集合 + 值），唯一的已知差异在下面单独断言。
    expect(Object.keys(newSends[0]!.payload).sort()).toEqual(Object.keys(oldSends[0]!.payload).sort())

    // 两侧都不产生 STREAM_ERROR（成功轮）。
    expect(old.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_ERROR)).toHaveLength(0)
    expect(next.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_ERROR)).toHaveLength(0)

    // 落盘顺序：user → assistant → result（两侧同序）。
    const types = (chain: DesktopChainHarness) => chain.host.session.appendCalls.map(batch => batch.map(m => m.type))
    expect(types(next)).toEqual(types(old))
    expect(types(next)[0]).toEqual(['user'])

    // 两侧都只有一次终态广播、一次 backlog 生命周期。
    expect(old.recorder.backlogBegin).toBe(1)
    expect(next.recorder.backlogBegin).toBe(1)
    expect(old.recorder.backlogFinish).toBe(1)
    expect(next.recorder.backlogFinish).toBe(1)
  })

  test('事件出口的已知差异被显式钉住（不是「顺手对齐」）', async () => {
    const old = createDesktopChain()
    const next = createDesktopChain()
    await old.runOld()
    await next.runNew()

    const oldKinds = backlogKinds(old.recorder)
    const newKinds = backlogKinds(next.recorder)

    // 旧链：run_complete 是唯一终态事件。
    expect(oldKinds).toContain('run_complete')
    expect(oldKinds).not.toContain('profer_event:run_completed')
    // 新链：host event port 额外投递 profer_event:run_completed（渲染层对它是 inert 的；
    // 刷新回放把它也识别为终态，因此 `hasTerminalEvent` 两侧一致）。
    expect(newKinds).toContain('run_complete')
    expect(newKinds).toContain('profer_event:run_completed')
    expect(newKinds).toContain('profer_event:external_run_started')
    // 旧链独有 run_idle（渲染层与 preload 都不消费它；main 侧的 runtimeContextStore 清理由
    // finishActiveStreamBacklog 承担，见下一条断言）。
    expect(oldKinds).toContain('profer_event:run_idle')
    expect(newKinds).not.toContain('profer_event:run_idle')
    // sdk_message 数量相同（两侧都是 result 一条）。
    expect(newKinds.filter(kind => kind === 'sdk_message')).toHaveLength(
      oldKinds.filter(kind => kind === 'sdk_message').length,
    )
    // 差异恰好是这三条：其余事件类型逐条相同。
    const normalize = (kinds: string[]) => kinds.filter(kind => !DESKTOP_CHAIN_ONLY_KINDS.includes(kind))
    expect(normalize(newKinds)).toEqual(normalize(oldKinds))
  })

  test('三条差异事件在渲染层都是 inert 的（读源码取证，不靠口头声明）', () => {
    const renderer = walkSources(new URL('../../../renderer/', import.meta.url))
    const preload = walkSources(new URL('../../../preload/', import.meta.url))
    for (const source of [...renderer, ...preload]) {
      expect(source.text).not.toContain('run_idle')
    }
    // external_run_started 在渲染层只做「不抢焦点」的会话状态激活，不切工作区 / 不切 Tab。
    const listeners = readRendererSource('hooks/useGlobalAgentListeners.ts')
    expect(listeners).toContain('外部来源（飞书/钉钉/微信/bridge）唤起的 run 不抢占前台')
    expect(listeners).toContain('只 upsert 本次 event 对应的会话，绝不用这份快照整体覆盖列表')
  })

  test('取消：新链的停止语义与既有 parity 一致，且终态只投递一次', async () => {
    // 只驱动新链：离线 fixture 里旧链的 provider abort 没有真实接线（`adapter.abort` 是空实现），
    // 旧链停止字段在本环境不具权威性；旧链停止语义由已有实机/其它套件覆盖。
    const keepAlive = () => (async function* stream(): AsyncGenerator<SDKMessage> {
      yield { type: 'assistant', session_id: 'parity-session', message: { content: [{ type: 'text', text: 'working' }] }, parent_tool_use_id: null } as unknown as SDKMessage
      // 周期性产出：保证 runtime 的 `iterator.return()`（关闭路径）能及时结算。
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 20))
        yield { type: 'system', subtype: 'thinking_tokens', session_id: 'parity-session' } as unknown as SDKMessage
      }
    })()

    const next = createDesktopChain({ stream: keepAlive })
    const running = next.startNew()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(next.coordinator.isRunning('parity-session')).toBe(true)
    await running.stop()
    await running.done

    const terminal = next.recorder.sends
      .filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
      .map(item => item.payload)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ stoppedByUser: true, endReason: 'stopped_by_user' })
    expect(next.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_ERROR)).toHaveLength(0)
    expect(next.coordinator.isRunning('parity-session')).toBe(false)
  })
})

// ============================================================================
// 4. backlog 与刷新回放
// ============================================================================

/** 用真实切片编译的 backlog 实现重放一条链本轮的事件流，返回 renderer 实际收到的 IPC 序列。 */
async function replayChain(chain: DesktopChainHarness): Promise<{
  ipc: Array<{ channel: string; kind: string }>
  snapshots: Array<{ sessionId: string; active: boolean; hasTerminalEvent: boolean }>
  emitted: AgentStreamPayload[]
}> {
  const { compiled, eventBus } = compileBacklog({
    isActive: () => false,
    messages: () => chain.host.session.agentMessages,
  })
  compiled.begin('parity-session')
  for (const payload of chain.recorder.payloads) eventBus.emit('parity-session', payload)
  compiled.finish('parity-session')

  const ipc: Array<{ channel: string; kind: string }> = []
  const fakeWc = {
    isDestroyed: () => false,
    once: () => {},
    send: (channel: string, payload: Record<string, unknown>) => {
      const inner = (payload?.payload ?? payload) as Record<string, unknown> | undefined
      const kind = typeof inner?.kind === 'string'
        ? (inner.kind === 'profer_event' && typeof (inner.event as { type?: unknown } | undefined)?.type === 'string'
            ? `profer_event:${(inner.event as { type: string }).type}`
            : String(inner.kind))
        : typeof inner?.type === 'string'
          ? String(inner.type)
          : channel
      ipc.push({ channel, kind })
    },
  }
  const snapshots = compiled.restore(fakeWc)
  return { ipc, snapshots, emitted: chain.recorder.payloads }
}

describe('backlog 与 renderer 刷新后的回放', () => {
  test('两条链的 backlog 都记入本轮全部实时事件，且终态可被识别（hasTerminalEvent 语义）', async () => {
    const old = createDesktopChain()
    const next = createDesktopChain()
    await old.runOld()
    await next.runNew()

    const oldReplay = await replayChain(old)
    const nextReplay = await replayChain(next)

    // 回放窗口里的 payload 序列（去掉 session_projection，与真实中间件同规则）
    const windowKinds = (payloads: AgentStreamPayload[]) => payloads.filter(isBacklogPayload).map(describePayload)
    const normalize = (kinds: string[]) => kinds.filter(kind => !DESKTOP_CHAIN_ONLY_KINDS.includes(kind)).sort()
    expect(normalize(windowKinds(nextReplay.emitted))).toEqual(normalize(windowKinds(oldReplay.emitted)))
    expect(windowKinds(oldReplay.emitted)).toContain('run_complete')
    expect(windowKinds(nextReplay.emitted)).toContain('profer_event:run_completed')

    // 回放出的 IPC：新链比旧链多一条 STREAM_COMPLETE ——
    // 来源是 host event port 的 `profer_event:run_completed` 与 `run_complete` 同时落在窗口里。
    // 渲染层对重复终态是幂等的（`isCurrentAgentStreamCompletion` 要求 running/backgroundWaiting，
    // 第一条 STREAM_COMPLETE 已把状态收敛为非 running），见下一条用例。
    const completeOld = oldReplay.ipc.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
    const completeNew = nextReplay.ipc.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
    expect(completeOld).toHaveLength(1)
    expect(completeNew).toHaveLength(2)
    expect(nextReplay.ipc.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_ERROR)).toHaveLength(0)

    // 非终态 STREAM_EVENT 序列（归一化掉三条已取证的差异事件）逐条一致。
    const nonTerminal = (ipc: Array<{ channel: string; kind: string }>) => normalize(
      ipc.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_EVENT)
        .map(item => item.kind)
        .filter(kind => kind !== 'run_complete' && kind !== 'run_error'),
    )
    expect(nonTerminal(nextReplay.ipc)).toEqual(nonTerminal(oldReplay.ipc))
  })

  test('重复终态在渲染层是幂等的（读真实渲染层守卫源码，不复制语义）', () => {
    const guard = readRendererSource('lib/agent-stream-state-cleanup.ts')
    expect(guard).toContain('if (!state || (!state.running && !state.backgroundWaiting)) return false')
    expect(guard).toContain('return state.startedAt == null || (completion.startedAt != null && state.startedAt <= completion.startedAt)')
  })
})

// ============================================================================
// 5. 未读与角标
// ============================================================================

describe('未读与角标口径', () => {
  test('关闭态（auto）：两侧都在请求入口清未读，且都不写终态未读', async () => {
    const old = createDesktopChain({ mode: 'auto' })
    const next = createDesktopChain({ mode: 'auto' })
    await old.runOld()
    await next.runNew()

    expect(old.recorder.entryUnreadClears).toEqual(['parity-session'])
    expect(next.recorder.entryUnreadClears).toEqual(['parity-session'])
    // 关闭态下 run 起点清未读与终态写未读都由策略短路（终态未读由渲染层 presence 判定写内存集合）。
    expect(old.recorder.completionUnread.map(item => item.decision)).toEqual([false])
    expect(next.recorder.completionUnread.map(item => item.decision)).toEqual([false])
  })

  test('开启态（manual）：两侧的「用户发起清未读 + 终态写未读」判定一致', async () => {
    const old = createDesktopChain({ mode: 'manual' })
    const next = createDesktopChain({ mode: 'manual' })
    await old.runOld()
    await next.runNew()

    expect(old.recorder.runStartUnread).toEqual([{ initiator: 'user', mode: 'manual', decision: true }])
    expect(next.recorder.runStartUnread).toEqual([{ initiator: 'user', mode: 'manual', decision: true }])
    expect(old.recorder.completionUnread).toEqual(next.recorder.completionUnread)
    expect(next.recorder.completionUnread).toEqual([
      { initiator: 'user', mode: 'manual', started: true, decision: true },
    ])
    // 开启态下入口仍走同一位置（helper 内部按模式短路），因此调用记录两侧相同。
    expect(old.recorder.entryUnreadClears).toEqual(['parity-session'])
    expect(next.recorder.entryUnreadClears).toEqual(['parity-session'])
  })

  test('后台任务续轮：新链咨询两次未读，软空闲被抑制、真终态写入', async () => {
    const backgroundStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
      yield { type: 'result', subtype: 'success', session_id: 'parity-session', _keepChannelOpenForTasks: true } as unknown as SDKMessage
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { type: 'assistant', session_id: 'parity-session', message: { content: [{ type: 'text', text: 'bg done' }] }, parent_tool_use_id: null } as unknown as SDKMessage
      yield { type: 'result', subtype: 'success', session_id: 'parity-session' } as unknown as SDKMessage
    })()

    const next = createDesktopChain({ mode: 'manual', stream: backgroundStream })
    await next.runNew()
    expect(next.recorder.completionUnread.map(item => item.backgroundTasksPending)).toEqual([true, undefined])
    expect(next.recorder.completionUnread.map(item => item.decision)).toEqual([false, true])
    // 软空闲那条终态带 backgroundTasksPending，真终态不带（与旧链 idleComplete 语义一致）。
    const completions = next.recorder.sends
      .filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
      .map(item => item.payload.backgroundTasksPending)
    expect(completions).toEqual([true, undefined])
  })

  test('从未启动的请求（并发拒绝）两侧都不写终态未读', async () => {
    const old = createDesktopChain({ stream: keepAliveStream })
    const next = createDesktopChain({ stream: keepAliveStream })

    const runningOld = old.startOld()
    await new Promise(resolve => setTimeout(resolve, 5))
    const rejectedOld = await old.runOld()
    expect(rejectedOld.rejected).toContain('AgentRunAlreadyActiveError')
    await runningOld.stop()
    await runningOld.done

    const runningNew = next.startNew()
    await new Promise(resolve => setTimeout(resolve, 5))
    const rejectedNew = await next.runNew()
    expect(rejectedNew.rejected).toContain('AgentRunAlreadyActiveError')
    await runningNew.stop()
    await runningNew.done

    // 入口清未读仍然发生（与旧链同位置，owner run 与被拒绝的请求各一次）；
    // 被拒绝的请求不算一轮，不产生终态未读。
    expect(old.recorder.entryUnreadClears).toEqual(['parity-session', 'parity-session'])
    expect(next.recorder.entryUnreadClears).toEqual(['parity-session', 'parity-session'])
    expect(old.recorder.completionUnread).toHaveLength(1)
    expect(next.recorder.completionUnread).toHaveLength(1)
    expect(old.recorder.completionUnread[0]?.started).toBe(true)
    expect(next.recorder.completionUnread[0]?.started).toBe(true)
  })
})

// ============================================================================
// 6. 草稿
// ============================================================================

const draftMeta = (): AgentSessionMeta => ({
  id: 'parity-session',
  title: '草稿会话',
  agentRuntime: 'pi',
  draft: true,
  createdAt: 1,
  updatedAt: 1,
})

describe('草稿晋升与拒绝恢复', () => {
  test('两侧都在 run 真正启动时晋升 draft，并广播投影 + 调宿主回调', async () => {
    const old = createDesktopChain({ meta: draftMeta() })
    const next = createDesktopChain({ meta: draftMeta() })
    await old.runOld()
    await next.runNew()

    expect(old.recorder.promotions).toEqual([{ sessionId: 'parity-session', promoted: true }])
    expect(next.recorder.promotions).toEqual([{ sessionId: 'parity-session', promoted: true }])
    expect(old.recorder.draftPromotedCallbacks).toEqual(['parity-session'])
    expect(next.recorder.draftPromotedCallbacks).toEqual(['parity-session'])
    expect(old.recorder.projections).toEqual(['parity-session'])
    expect(next.recorder.projections).toEqual(['parity-session'])
    expect(next.host.session.meta?.draft).toBe(false)
  })

  test('守卫拦下的请求不晋升 draft（未启动 = 不算一轮）', async () => {
    const next = createDesktopChain({ meta: draftMeta(), guard: () => '会话正在删除，无法发送消息' })
    await next.runNew()
    expect(next.recorder.promotions).toEqual([])
    expect(next.recorder.draftPromotedCallbacks).toEqual([])
    expect(next.host.session.meta?.draft).toBe(true)
  })

  test('被拒绝（并发）时向 IPC 抛具名错误，让渲染层恢复发送前状态与草稿', async () => {
    const next = createDesktopChain({ stream: keepAliveStream })
    const running = next.startNew()
    await new Promise(resolve => setTimeout(resolve, 5))
    const rejected = await next.runNew()
    expect(rejected.rejected).toContain('AgentRunAlreadyActiveError')
    // 拒绝路径不投递任何终态（否则会假性关闭 owner run）。
    expect(next.recorder.sends).toHaveLength(0)
    await running.stop()
    await running.done

    // 渲染层侧：拒绝即恢复草稿（读源码取证，不复制语义）。
    const view = readRendererSource('components/agent/AgentView.tsx')
    expect(view).toContain('if (isAgentRunAlreadyActiveError(error)) {')
    expect(view).toContain('removeOptimisticPersistedMessage(messageUuid)')
    expect(view).toContain('setInputContent(effectiveText)')
  })
})

// ============================================================================
// 7. 权限与计划模式的渲染层出口
// ============================================================================

function parityPreset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'parity-preset',
    name: 'parity preset',
    description: '',
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function planPolicy(): AgentRuntimePolicyResolutionInput {
  return {
    preset: parityPreset() as never,
    presetReference: { presetId: 'parity-preset', presetScope: 'user-global' },
    permissionModeOverride: 'plan',
  }
}

describe('权限与计划模式的渲染层出口', () => {
  test('plan：两条链都把 enter_plan_mode / plan_mode_changed 送到同一事件出口', async () => {
    const old = createDesktopChain()
    const next = createDesktopChain({ policy: planPolicy() })
    await old.runOld(defaultInput({ permissionModeOverride: 'plan' }))
    await next.runNew()

    const planKinds = (chain: DesktopChainHarness) => new Set(
      backlogKinds(chain.recorder).filter(kind => kind.startsWith('profer_event:')),
    )
    const oldKinds = planKinds(old)
    const nextKinds = planKinds(next)
    for (const expected of ['profer_event:enter_plan_mode', 'profer_event:plan_mode_changed']) {
      expect(oldKinds.has(expected)).toBe(true)
      expect(nextKinds.has(expected)).toBe(true)
    }
  })

  test('审批请求（permission_request / exit_plan_mode_request）的渲染层通道仍是 profer_event', () => {
    // 入口把计划模式事件接到 host port 的 host_event；host port 统一转成 profer_event。
    const entry = readMainSource('agent-runtime-desktop-entry.ts')
    expect(entry).toContain('emitPlanModeEvent')
    const host = readMainSource('agent-runtime-host.ts')
    expect(host).toContain("eventBus.emit(sessionId, { kind: 'profer_event', event: event.event })")
    // 渲染层把这几种 profer_event 映射回旧 AgentEvent（弹窗 / 横幅）。
    const listeners = readRendererSource('hooks/useGlobalAgentListeners.ts')
    for (const type of [
      'permission_request',
      'exit_plan_mode_request',
      'exit_plan_mode_resolved',
      'enter_plan_mode',
      'plan_mode_changed',
    ]) {
      expect(listeners).toContain(`case '${type}':`)
    }
  })
})

// ============================================================================
// 8. 删除 / 分叉守卫与执行权互斥
// ============================================================================

describe('删除 / 分叉守卫与新执行权', () => {
  test('守卫拦下：两侧都是「错误 + 空终态」，且不取执行权、不晋升草稿', async () => {
    const deleting = '会话正在删除，无法发送消息'
    const old = createDesktopChain()
    const next = createDesktopChain({ guard: () => deleting })

    // 旧链的守卫在 orchestrator 内部（`deletingSessions`），用真实 API 触发。
    old.old.instance.beginDeletion('parity-session')
    await old.runOld()
    await next.runNew()

    const errors = (chain: DesktopChainHarness) => chain.recorder.sends
      .filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_ERROR)
      .map(item => item.payload.error)
    const completions = (chain: DesktopChainHarness) => chain.recorder.sends
      .filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
      .map(item => item.payload)
    expect(errors(old)).toEqual([deleting])
    expect(errors(next)).toEqual([deleting])
    expect(completions(old)).toHaveLength(1)
    expect(completions(next)).toHaveLength(1)
    expect(Object.keys(completions(next)[0]!).sort()).toEqual(Object.keys(completions(old)[0]!).sort())
    expect(completions(next)[0]).toMatchObject({ stoppedByUser: false, initiator: 'user', messages: [] })
    // 未取得执行权 ⇒ provider 不启动。
    expect(old.old.recording.providerStarts).toBe(0)
    expect(next.coordinator.isRunning('parity-session')).toBe(false)
    // 两侧都不晋升草稿（未启动 = 不算一轮）。
    expect(old.recorder.promotions).toEqual([])
    expect(next.recorder.promotions).toEqual([])
  })

  test('同一会话不得被两条链同时执行（双向）', async () => {
    // 旧链持有 → 新链被拒。
    const a = createDesktopChain({ stream: keepAliveStream })
    const holdingOld = a.startOld()
    await new Promise(resolve => setTimeout(resolve, 10))
    const sendsBefore = a.recorder.sends.length
    const rejectedNew = await a.runNew()
    expect(rejectedNew.rejected).toContain('AgentRunAlreadyActiveError')
    expect(a.recorder.sends).toHaveLength(sendsBefore)
    expect(a.recorder.promotions).toEqual([])
    await holdingOld.stop()
    await holdingOld.done

    // 新链持有 → 旧链被拒。
    const b = createDesktopChain({ stream: keepAliveStream })
    const holdingNew = b.startNew()
    await new Promise(resolve => setTimeout(resolve, 10))
    const sendsBeforeB = b.recorder.sends.length
    const rejectedOld = await b.runOld()
    expect(rejectedOld.rejected).toContain('AgentRunAlreadyActiveError')
    expect(b.recorder.sends).toHaveLength(sendsBeforeB)
    await holdingNew.stop()
    await holdingNew.done
  })
})

// ============================================================================
// 9. 桌面缺口：GAP-D1（自动标题生成）与 GAP-D2（锁定后投影）的关闭证据
// ============================================================================

/** 一条链在一次会话里产出的「标题痕迹」（两条链用同一组断言比较）。 */interface TitleTrace {
  /** `profer_event: title_updated` 的标题序列（事件出口，按顺序）。 */
  events: string[]
  /** `TITLE_UPDATED` 专用 IPC 的载荷序列。 */
  sends: Array<{ sessionId: unknown; title: unknown }>
  /** 实际发起的生成调用（渠道 / 模型 / 来源同一份判据的实证）。 */
  generations: AgentGenerateTitleInput[]
  /** 标题窗口写回会话元数据的顺序（title / titleAutoGeneratedAt / titleLockedAt / titleRefineAttempts）。 */
  metaWrites: Array<Partial<AgentSessionMeta>>
  /** 最终会话元数据里的标题相关字段。 */
  meta: Pick<AgentSessionMeta, 'title' | 'titleAutoGeneratedAt' | 'titleLockedAt' | 'titleRefineAttempts'>
  /**
   * 事件出口里 `run_complete` 之前出现的标题事件数 —— 直接验证「标题事件先于终态广播」。
   */
  titleEventsBeforeTerminal: number
}

const titleFields = (meta: AgentSessionMeta | undefined): TitleTrace['meta'] => ({
  title: meta?.title ?? '',
  ...(meta?.titleAutoGeneratedAt !== undefined ? { titleAutoGeneratedAt: meta.titleAutoGeneratedAt } : {}),
  ...(meta?.titleLockedAt !== undefined ? { titleLockedAt: meta.titleLockedAt } : {}),
  ...(meta?.titleRefineAttempts !== undefined ? { titleRefineAttempts: meta.titleRefineAttempts } : {}),
})

const isTitleUpdatedPayload = (
  payload: AgentStreamPayload,
): payload is { kind: 'profer_event'; event: { type: 'title_updated'; title: string } } =>
  payload.kind === 'profer_event' && payload.event.type === 'title_updated'

const isTitleMetaWrite = (patch: Partial<AgentSessionMeta>): boolean =>
  patch.title !== undefined
  || patch.titleAutoGeneratedAt !== undefined
  || patch.titleLockedAt !== undefined
  || patch.titleRefineAttempts !== undefined
  || patch.explorationTitleInitializedAt !== undefined

function titleTrace(chain: DesktopChainHarness, generations: AgentGenerateTitleInput[]): TitleTrace {
  const titleEvents = chain.recorder.payloads.filter(isTitleUpdatedPayload)
  const firstTerminal = chain.recorder.payloads.findIndex(payload => payload.kind === 'run_complete')
  return {
    events: titleEvents.map(payload => payload.event.title),
    sends: chain.recorder.sends
      .filter(item => item.channel === AGENT_IPC_CHANNELS.TITLE_UPDATED)
      .map(item => ({ sessionId: item.payload.sessionId, title: item.payload.title })),
    generations,
    metaWrites: chain.host.session.metaPatches.filter(isTitleMetaWrite),
    meta: titleFields(chain.host.session.meta),
    titleEventsBeforeTerminal: firstTerminal < 0
      ? titleEvents.length
      : chain.recorder.payloads
        .slice(0, firstTerminal)
        .filter(isTitleUpdatedPayload)
        .length,
  }
}

/**
 * 时间戳在两条链之间必然不同（各自 `Date.now()`）：比较**形状**而不是值。
 * `titleRefineAttempts` 等语义值照原样比较，`*At` 时间戳只比「是否写入」。
 */
const titleWriteShape = (
  writes: Array<Partial<AgentSessionMeta>>,
): Array<Record<string, unknown>> => writes.map(patch => Object.fromEntries(
  Object.entries(patch).map(([key, value]) => [
    key,
    typeof value === 'number' && key.endsWith('At') ? '<timestamp>' : value,
  ]),
))

/** 新会话的初始元数据（与 `createAgentSession` 的默认标题一致：「新 Agent 会话」）。 */
const freshMeta = (overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta => ({
  id: 'parity-session',
  title: DEFAULT_SESSION_TITLE,
  agentRuntime: 'pi',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

interface TitleParityHarness {
  old: TitleTrace
  next: TitleTrace
}

/**
 * 在**同一会话输入**上先后驱动旧链与新链，返回两侧的标题痕迹。
 *
 * 生成器一律用替身（要求：测试不得调真实模型）：旧链用 `spyOn(instance, 'generateTitle')`
 * 换掉真实渠道请求，新链用注入的 `titleNaming.generate`。两侧替身返回同一个标题，
 * 因此比较的是「何时生成 / 生成几次 / 何时锁定 / 事件字段」，不是模型输出。
 */
async function driveTitleParity(
  turns: Array<{ input: AgentSendInput; title: string | null }>,
  chainOptions: DesktopChainOptions = {},
): Promise<TitleParityHarness> {
  // 默认给一个「新建会话」元数据（标题 = 默认标题、未定稿、未自动命名过）——
  // 否则 fixture 的占位标题会被窗口判为人工命名，窗口在预判阶段就关闭。
  const baseOptions: DesktopChainOptions = { meta: chainOptions.meta ?? freshMeta(), ...chainOptions }
  const oldChain = createDesktopChain({ ...baseOptions, meta: { ...baseOptions.meta! } })
  const oldGenerations: AgentGenerateTitleInput[] = []
  const scriptedTitle = (index: number) => turns[index]?.title ?? null
  let oldTurn = 0
  spyOn(oldChain.old.instance, 'generateTitle').mockImplementation(async (titleInput: AgentGenerateTitleInput) => {
    oldGenerations.push(titleInput)
    return scriptedTitle(oldTurn)
  })
  for (const turn of turns) {
    await oldChain.runOld(turn.input)
    oldTurn += 1
  }

  let newTurn = 0
  const nextChain = createDesktopChain({
    ...baseOptions,
    meta: { ...baseOptions.meta! },
    titleNaming: {
      generate: async (titleInput: AgentGenerateTitleInput) => {
        void titleInput
        return scriptedTitle(newTurn)
      },
    },
  })
  for (const turn of turns) {
    await nextChain.runNew(turn.input)
    newTurn += 1
  }

  return {
    old: titleTrace(oldChain, oldGenerations),
    next: titleTrace(nextChain, nextChain.recorder.titleGenerations),
  }
}

/** 信息量足够的用户消息（寒暄/命令会被判为无来源，不能用来驱动命名窗口）。 */
const informativeInput = (userMessage: string): AgentSendInput => defaultInput({ userMessage, modelId: 'parity-model' })

const INFORMATIVE_1 = '帮我比较 grok 和 gpt 在长上下文上的差异'
const INFORMATIVE_2 = '再补充一份两者在工具调用上的对比表格'

describe('桌面切换前缺口的关闭证据', () => {
  test('GAP-D1（已关闭）：判据与编排只有一份实现，旧链与新链都 import 它', () => {
    const orchestrator = readMainSource('agent-orchestrator.ts')
    // 旧链仍由编排器触发（位置不变），但判据与编排已提取到共享模块：编排器自己不再持有第二套。
    expect(orchestrator).toContain('await this.autoGenerateTitle(')
    expect(orchestrator).toContain("from './agent-session-title-naming'")
    expect(orchestrator).toContain('await runSessionTitleNaming({')
    expect(orchestrator).toContain('collectSessionTitleSources({')
    expect(orchestrator).not.toContain('preflightTitleWindow(')
    expect(orchestrator).not.toContain('planTitleWindow(')

    const entry = readMainSource('agent-runtime-entry.ts')
    expect(entry).toContain("from './agent-session-title-naming'")
    expect(entry).toContain('await runSessionTitleNaming({')
    expect(entry).not.toContain('preflightTitleWindow(')
    expect(entry).not.toContain('planTitleWindow(')

    // 判据本身（窗口状态机 + 来源过滤）只在 `title-generation.ts`，两条链都经共享模块取用。
    const shared = readMainSource('agent-session-title-naming.ts')
    expect(shared).toContain('preflightTitleWindow(')
    expect(shared).toContain('planTitleWindow(')
    expect(shared).toContain('collectSessionTitleSources(')
    expect(countOccurrences(readMainSource('title-generation.ts'), 'export function planTitleWindow(')).toBe(1)

    // 专用 IPC 通道与事件类型只出现在宿主投影里（与旧链逐字同形）。
    const agentService = readMainSource('agent-service.ts')
    expect(agentService).toContain("event: { type: 'title_updated', title }")
    const hostWiring = sliceBetween(
      agentService,
      'function buildRuntimeTitleNaming(',
      '/**\n * 关闭态（`auto`）下',
      'buildRuntimeTitleNaming',
    )
    // runtime 链的投影只有一处：事件出口 + 专用 IPC（与旧链 `runAgent.onTitleUpdated` 同形）。
    expect(countOccurrences(hostWiring, 'AGENT_IPC_CHANNELS.TITLE_UPDATED')).toBe(1)
    expect(hostWiring).toContain("event: { type: 'title_updated', title }")

    // 共享入口把标题窗口接在「成功终态、终态广播之前」，条件与旧链逐条对齐。
    expect(entry).toContain("if (titleNaming && outcome.status === 'completed' && (readResultSignal(lastResultMessage).errors ?? []).length === 0) {")
  })

  test('GAP-D1（已关闭）：同一会话输入下，旧链与新链产出的标题事件序列一致', async () => {
    const parity = await driveTitleParity([
      { input: informativeInput(INFORMATIVE_1), title: '临时标题·首轮' },
    ])
    // 首轮：两条链都生成 1 次，都只发一条 title_updated（事件类型 / 字段相同）。
    expect(parity.next.events).toEqual(parity.old.events)
    expect(parity.next.events).toEqual(['临时标题·首轮'])
    expect(parity.next.sends).toEqual(parity.old.sends)
    expect(parity.next.sends).toEqual([{ sessionId: 'parity-session', title: '临时标题·首轮' }])
    // 同一份来源 / 同一渠道 / 同一模型。
    expect(parity.next.generations).toEqual(parity.old.generations)
    expect(parity.next.generations).toEqual([{
      userMessage: INFORMATIVE_1,
      channelId: 'parity-channel',
      modelId: 'parity-model',
      contextMessages: [INFORMATIVE_1],
    }])
    // 首轮只预占一次尝试且**不定稿**（需要第二条有效来源才锁定）。
    expect(titleWriteShape(parity.next.metaWrites)).toEqual(titleWriteShape(parity.old.metaWrites))
    expect(parity.next.meta.titleRefineAttempts).toBe(1)
    expect(parity.next.meta.titleLockedAt).toBeUndefined()
    expect(parity.next.meta.title).toBe('临时标题·首轮')
    expect(parity.next.meta.titleAutoGeneratedAt).toBeNumber()
    // 标题事件先于终态广播（与旧链位置一致）。
    expect(parity.next.titleEventsBeforeTerminal).toBe(1)
    expect(parity.old.titleEventsBeforeTerminal).toBe(1)
  })

  test('GAP-D1（已关闭）：第二条有效来源定稿，窗口关闭后不再生成（次数与旧链一致）', async () => {
    const parity = await driveTitleParity([
      { input: informativeInput(INFORMATIVE_1), title: '临时标题·首轮' },
      { input: informativeInput(INFORMATIVE_2), title: '定稿标题·第二轮' },
      { input: informativeInput('再顺手写一段迁移注意事项'), title: '不应出现的第三轮标题' },
    ])
    expect(parity.next.events).toEqual(parity.old.events)
    expect(parity.next.events).toEqual(['临时标题·首轮', '定稿标题·第二轮'])
    expect(parity.next.sends).toEqual(parity.old.sends)
    expect(parity.next.generations).toEqual(parity.old.generations)
    expect(parity.next.generations).toHaveLength(2)
    // 第二轮把前两条有效用户消息一起喂给生成器（窗口语义）。
    expect(parity.next.generations[1]?.contextMessages).toEqual([INFORMATIVE_1, INFORMATIVE_2])
    expect(parity.next.generations[1]?.userMessage).toBe(INFORMATIVE_1)
    // 第二轮定稿后第三轮不再发起生成（attempts 不增、标题不变）。
    expect(parity.next.meta.title).toBe('定稿标题·第二轮')
    expect(parity.next.meta.titleRefineAttempts).toBe(2)
    expect(parity.next.meta.titleLockedAt).toBeNumber()
    expect(titleWriteShape(parity.next.metaWrites)).toEqual(titleWriteShape(parity.old.metaWrites))
    // 旧链确实也跑了同一份窗口（否则这里的相等可能是「两侧都没跑」的假绿）。
    expect(parity.old.meta.titleRefineAttempts).toBe(2)
    expect(parity.old.meta.title).toBe('定稿标题·第二轮')
    expect(parity.old.meta.titleLockedAt).toBeNumber()
  })

  test('GAP-D1（已关闭）：人工命名 / 寒暄开场都与旧链同形（不覆盖用户改名、无来源不烧次数）', async () => {
    // 人工命名：窗口在预判阶段就关闭（写 titleLockedAt），从不调用生成器。
    const manualTitleMeta: AgentSessionMeta = {
      id: 'parity-session',
      title: '我自己起的名字',
      agentRuntime: 'pi',
      createdAt: 1,
      updatedAt: 1,
    }
    const renamed = await driveTitleParity(
      [{ input: informativeInput(INFORMATIVE_1), title: '不应出现' }],
      { meta: manualTitleMeta },
    )
    expect(renamed.next.events).toEqual(renamed.old.events)
    expect(renamed.next.events).toEqual([])
    expect(renamed.next.generations).toEqual([])
    expect(titleWriteShape(renamed.next.metaWrites)).toEqual(titleWriteShape(renamed.old.metaWrites))
    expect(renamed.next.meta.title).toBe('我自己起的名字')
    expect(renamed.next.meta.titleLockedAt).toBeNumber()
    // 旧链同样在预判阶段关窗（写 titleLockedAt、不调生成器）——避免「两侧都是空序列」的假绿。
    expect(renamed.old.metaWrites).toEqual([{ titleLockedAt: expect.any(Number) }])
    expect(renamed.old.meta.title).toBe('我自己起的名字')

    // 寒暄开场：无有效来源 → 不生成、不消耗尝试次数；随后的有效消息正常生成。
    const chatty = await driveTitleParity([
      { input: informativeInput('hi'), title: null },
      { input: informativeInput(INFORMATIVE_1), title: '寒暄之后的首个标题' },
    ])
    expect(chatty.next.events).toEqual(chatty.old.events)
    expect(chatty.next.events).toEqual(['寒暄之后的首个标题'])
    expect(chatty.next.generations).toEqual(chatty.old.generations)
    // 寒暄那一轮已经落盘成会话消息，但不构成命名来源：第一次生成仍只有 1 次尝试、且未定稿。
    expect(chatty.next.generations).toHaveLength(1)
    expect(chatty.next.meta.titleRefineAttempts).toBe(1)
    expect(chatty.next.meta.titleLockedAt).toBeUndefined()
  })

  test('GAP-D1（已关闭）：生成失败 / 运行失败 / 用户停止都不产生标题事件，也不阻断本轮', async () => {
    // 生成器返回 null（渠道不可用 / 清洗后为空）：算一次尝试，但没有标题事件，本轮仍完成。
    const generationFails = await driveTitleParity([
      { input: informativeInput(INFORMATIVE_1), title: null },
    ])
    expect(generationFails.old.events).toEqual([])
    expect(generationFails.next.events).toEqual([])
    expect(generationFails.next.generations).toEqual(generationFails.old.generations)
    expect(titleWriteShape(generationFails.next.metaWrites)).toEqual(titleWriteShape(generationFails.old.metaWrites))
    expect(generationFails.next.meta.titleRefineAttempts).toBe(1)
    expect(generationFails.next.meta.title).not.toBe('临时标题·首轮')

    // 运行失败（provider 抛错）：不生成标题，终态仍是错误（标题逻辑不影响终态语义）。
    const failing = () => (async function* stream(): AsyncGenerator<SDKMessage> {
      throw new Error('503 upstream busy')
    })()
    const failedChain = createDesktopChain({
      stream: failing,
      titleNaming: { generate: async () => '不应出现的标题' },
    })
    await failedChain.runNew(informativeInput(INFORMATIVE_1))
    expect(failedChain.recorder.titleGenerations).toEqual([])
    expect(failedChain.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.TITLE_UPDATED)).toEqual([])
    expect(failedChain.recorder.sends
      .filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
      .map(item => item.payload.endReason)).toEqual(['error'])

    // 用户停止：同样不生成标题。
    const stoppedChain = createDesktopChain({
      stream: keepAliveStream,
      titleNaming: { generate: async () => '不应出现的标题' },
    })
    const running = stoppedChain.startNew(informativeInput(INFORMATIVE_1))
    await new Promise(resolve => setTimeout(resolve, 10))
    await running.stop()
    await running.done
    expect(stoppedChain.recorder.titleGenerations).toEqual([])
    expect(stoppedChain.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.TITLE_UPDATED)).toEqual([])
    expect(stoppedChain.recorder.sends
      .filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)
      .map(item => item.payload.stoppedByUser)).toEqual([true])

    // result 带 errors（流正常结束但本轮不算成功）：两条链都跳过命名
    // （旧链判据是 `!capturedResultErrors?.length`，新链必须用同一份事实，而不是只看 outcome）。
    const errorResultStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
      yield { type: 'result', subtype: 'success', session_id: 'parity-session', errors: ['收尾阶段上游报错'] } as unknown as SDKMessage
    })()
    const oldWithErrors = createDesktopChain({ stream: errorResultStream })
    const oldErrorsSpy = spyOn(oldWithErrors.old.instance, 'generateTitle').mockResolvedValue('不应出现的标题')
    await oldWithErrors.runOld(informativeInput(INFORMATIVE_1))
    expect(oldErrorsSpy).not.toHaveBeenCalled()

    const newWithErrors = createDesktopChain({
      stream: errorResultStream,
      titleNaming: { generate: async () => '不应出现的标题' },
    })
    await newWithErrors.runNew(informativeInput(INFORMATIVE_1))
    expect(newWithErrors.recorder.titleGenerations).toEqual([])
    expect(newWithErrors.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.TITLE_UPDATED)).toEqual([])
    // 两侧仍各自给出终态（标题逻辑不影响终态语义）。
    expect(newWithErrors.recorder.sends.filter(item => item.channel === AGENT_IPC_CHANNELS.STREAM_COMPLETE)).toHaveLength(1)
  })

  test('GAP-D2（已关闭）：runtime 锁定后的会话投影在新路径也广播', () => {
    const orchestrator = readMainSource('agent-orchestrator.ts')
    expect(orchestrator).toContain('const locked = this.sessionPort.lockRuntime(sessionId, agentRuntime)')
    expect(orchestrator).toContain("kind: 'session_projection', operation: 'upsert', session: buildAgentSessionUiProjection(locked)")

    // 集成会话把广播接在宿主 SessionPort 的 lockRuntime 上（IR-D3 推荐方案 ①）。
    const host = readMainSource('agent-runtime-host.ts')
    expect(host).toContain('lockRuntime(sessionId, runtime) {')
    expect(host).toContain('publishAgentSessionProjection(locked)')
    // 仍不得在 `lockAgentSessionRuntime` 内部广播（会改变 headless / remote 的广播面语义）。
    const manager = readMainSource('agent-session-manager.ts')
    const lockBody = sliceBetween(
      manager,
      'export function lockAgentSessionRuntime(',
      '/** 获取单个会话的元数据。 */',
      'lockAgentSessionRuntime',
    )
    expect(lockBody).toContain('return updateAgentSessionMeta(id, { agentRuntimeLocked: true })')
    expect(lockBody).not.toContain('session_projection')
  })
})
