/**
 * B8-Pi 等价性对照：Pi 工具装配 context 的产品字段 vs **真实旧编排层源码切片**。
 *
 * 背景：Claude 侧的产品能力走 `mcpServers`（B8 已闭合）；Pi 侧走 `buildPiBuiltinTools(sdk, ctx)`，
 * ctx 在旧链由 `agent-orchestrator.ts` 的 Pi 装配块逐条构造，在新路径由宿主
 * （`agent-runtime-host.ts` 的 `createElectronToolAssemblyPort` + 产品能力表投影）构造。
 * 本文件比较两侧在**同一 preset / 同一上下文**下交给 `buildPiBuiltinTools` 的 key：
 *
 * 1. `allowedRoots`（旧链 `browserAllowedRoots`）——逐值比较；
 * 2. `visualizationStorageDir`（旧链 `workspaceSlug && agentCwd ? agentSessionVisualizationsDir(...) : undefined`）；
 * 3. 三个回调的行为（调用后两侧发出 / 收到的载荷逐字比较）：`onVisualizationUpdate`、
 *    `onPreviewRequest`、`onPreviewInspectRequest`；
 * 4. `assertCanPresentVisualization` 的**顺序与文案**（先取消、后计划模式）；
 * 5. 最强证据：把两侧 context 真喂给**真实 `buildPiBuiltinTools`**，逐条比较注册出来的产品工具名。
 *
 * 旧侧用 `runtime-migration-parity/support/compile-slice.ts` 编译**真实源码**（不手抄一份旧逻辑）：
 * - 切片 A：产品授权根 + 三个回调 + 公布门禁（`agent-orchestrator.ts` 第二个 `promptMode === 'standard'`
 *   注入块及其上方的局部量）；
 * - 切片 B1/B2：`browserAllowedRoots` 与 `this.buildPiBuiltinTools(piSdk, { … })` 的**context 字面量**。
 * 三片拼进同一个函数体执行，因此 B2 引用的 `emitVisualizationUpdate` /
 * `assertCanPresentVisualization` / `browserAllowedRoots` 都是真实切片的产物。
 *
 * 省略的中间段（Pi harness / 权限模式 bookkeeping / plugin tools）与本对照的字段无关；
 * 标记失效会抛 `SliceMarkerError` 显式失败，不会静默比到别处。
 */

import { describe, expect, mock, test } from 'bun:test'
import { normalizeAgentRuntime } from '@profer/shared'
import type { AgentPreset, AgentSendInput } from '@profer/shared'
import { createAgentQueryPreparationPort } from '@profer/agent-runtime'
import { collectAttachedDirectories, collectProductArtifactDirectories } from './agent-directory-utils'
import { agentSessionVisualizationsDir } from './config-paths'
import { compileSlice, readMainSource, sliceBetween } from './runtime-migration-parity/support/compile-slice'

// 生图可用性在测试环境恒为假（未配置生图工具）。两侧共用同一替身，
// 否则「Pi 的 generate_image 是否恢复」这条对照会退化成两边都为空。
mock.module('./agent-gpt-image-tools', () => ({
  AGENT_GPT_IMAGE_TOOL_NAME: 'generate_image',
  AGENT_GPT_IMAGE_DESCRIPTION: 'parity fixture description',
  formatAgentGptImageToolResult: (result: unknown) => ({ content: [], details: result }),
  isAgentGptImageAvailable: () => true,
  // 旧链的 claude 注入器在本文件不参与对照（只被模块图静态导入）。
  injectAgentGptImageMcpServer: async () => {},
}))

const { createElectronAgentHost, clearAgentRuntimeRunFacts } = await import('./agent-runtime-host')
const { agentRuntimePolicyRuns, resolveAgentRuntimePolicySnapshot } = await import('./agent-runtime-policy-snapshot')
import type { AgentRuntimePolicyResolutionInput } from './agent-runtime-policy-snapshot'
const { createRuntimeEntryQuery } = await import('./agent-runtime-entry')
const { buildPiBuiltinTools } = await import('./adapters/pi-builtin-tools')

const orchestratorSource = readMainSource('agent-orchestrator.ts')
const agentServiceSource = readMainSource('agent-service.ts')
const entrySource = readMainSource('agent-runtime-entry.ts')

// ===== 旧链切片 =====

const SLICE_A_START = '// 本地图片输出只在受工作区授权的会话注册'
const SLICE_A_END = "const pluginTools = promptMode === 'light' ? [] : await buildPluginAgentTools("
const SLICE_B1_START = '// 受管浏览器允许读取的根目录 = 会话工作目录 + 会话/工作区已授权目录'
const SLICE_B1_END = '// Claude SDK 原生接收 mcpServers；Pi 必须将同一配置连接后转换为 customTools。'
const SLICE_B2_START = 'const builtin = await this.buildPiBuiltinTools(piSdk, {'
const SLICE_B2_END = 'const mcpTools = await buildPiMcpTools(mcpServers, presetPolicy)'

/** 新路径基座 context 的真实来源（`agent-service.ts` 的 `buildRuntimeHeadlessRunContext`）。 */
const BASE_SLICE_START = 'function buildRuntimeHeadlessRunContext('
const BASE_SLICE_END = '/**\n * 解析本轮的有效策略上下文'

const SESSION_ID = 'parity-pi-session'
const CHANNEL_ID = 'parity-channel'
const MODEL_ID = 'parity-model'
const WORKSPACE_ID = 'parity-workspace'
const USER_MESSAGE = 'hello'
const ADDITIONAL_DIRECTORIES = ['/parity/attached'] as const
const FALLBACK_CWD = '/parity/session-cwd'
const FIXTURE_SDK = { fixture: 'pi-sdk' }
const FIXTURE_PREVIEW_EVENT = { sessionId: SESSION_ID, type: 'preview_requested', filePath: '/parity/session-cwd/deck.pptx' } as never
const FIXTURE_INSPECT_REQUEST = { sessionId: SESSION_ID, filePath: '/parity/session-cwd/deck.pptx', scope: 'overview' } as never
const FIXTURE_VISUALIZATION = { visualizationId: 'viz-1', revision: 'rev-1' } as never

interface AssemblyCase {
  label: string
  workspaceSlug: string | undefined
  cwd: string | undefined
  disabledToolGroups: readonly string[]
  pptCapabilityActive: boolean
}

const cases: AssemblyCase[] = [
  { label: 'all-on', workspaceSlug: 'parity-slug', cwd: FALLBACK_CWD, disabledToolGroups: [], pptCapabilityActive: true },
  { label: 'no-cwd', workspaceSlug: 'parity-slug', cwd: undefined, disabledToolGroups: [], pptCapabilityActive: true },
  { label: 'no-workspace', workspaceSlug: undefined, cwd: undefined, disabledToolGroups: [], pptCapabilityActive: true },
  { label: 'no-ppt', workspaceSlug: 'parity-slug', cwd: FALLBACK_CWD, disabledToolGroups: [], pptCapabilityActive: false },
  { label: 'preview-disabled', workspaceSlug: 'parity-slug', cwd: FALLBACK_CWD, disabledToolGroups: ['preview'], pptCapabilityActive: true },
  { label: 'image-disabled', workspaceSlug: 'parity-slug', cwd: FALLBACK_CWD, disabledToolGroups: ['image'], pptCapabilityActive: true },
  { label: 'clipboard+browser-disabled', workspaceSlug: 'parity-slug', cwd: FALLBACK_CWD, disabledToolGroups: ['clipboard', 'browser'], pptCapabilityActive: true },
  { label: 'all-groups-disabled', workspaceSlug: 'parity-slug', cwd: FALLBACK_CWD, disabledToolGroups: ['preview', 'image', 'clipboard', 'browser', 'ppt-materials'], pptCapabilityActive: true },
]

/** 两侧共用的会话元数据（旧链由编排层读取，新路径由宿主读取同一份事实）。 */
const sessionMeta = {
  id: SESSION_ID,
  title: 'parity pi session',
  workspaceId: WORKSPACE_ID,
  agentRuntime: 'pi' as const,
  createdAt: 1,
  updatedAt: 1,
}

interface CapabilityState {
  runActive: boolean
  /** 计划模式在 run 起点即为真（旧链 `planModeEntered` / 新路径 `isPlanActive()`）。 */
  planMode: boolean
  /** 运行中切到计划模式（旧链 `sessionPermissionModes` 分支）。 */
  sessionPlanMode?: boolean
}

const ACTIVE_RUN: CapabilityState = { runActive: true, planMode: false }

interface OldRunResult {
  context: Record<string, unknown>
  events: Array<{ sessionId: string; payload: Record<string, unknown> }>
  previewCalls: Array<Record<string, unknown>>
}

/**
 * 旧侧装配：切片编译的真实旧源码，`this.buildPiBuiltinTools` 换成记录器。
 *
 * `assertCanPresentVisualization` 的判定源与旧链一致：`stoppedBySessions` /
 * `activeSessions` 代次 / `sessionPermissionModes` / `presetPolicy.permissionMode`。
 */
function buildOldAssembly() {
  const sliceA = sliceBetween(orchestratorSource, SLICE_A_START, SLICE_A_END, 'pi-product-roots')
  const sliceB1 = sliceBetween(orchestratorSource, SLICE_B1_START, SLICE_B1_END, 'pi-browser-roots')
  const sliceB2 = sliceBetween(orchestratorSource, SLICE_B2_START, SLICE_B2_END, 'pi-assembly-context')
  const body = [sliceA, sliceB1, sliceB2].join('\n').replace(/\bthis\./g, 'self.')

  const wrapper = [
    'async function runOldPiAssembly(ctx) {',
    '  const { sessionId, channelId, modelId, agentRuntime, workspaceId, workspaceSlug, agentCwd,',
    '    input, promptMode, initialPermissionMode, disabledToolGroups, disabledTools,',
    '    pptCapabilityActive, additionalDirectories, sessionMeta, presetPolicy, runGeneration,',
    '    allowedPresetOperations, currentPresetReference, userMessage, userConfirmedPresetChange,',
    '    pendingPresetChange, piSdk, sdk, mcpServers, self } = ctx',
    body,
    '}',
  ].join('\n')

  const recordInjector = async () => {}
  const run = compileSlice<(ctx: Record<string, unknown>) => Promise<void>>(wrapper, 'runOldPiAssembly', {
    collectAttachedDirectories: (value: unknown) => collectAttachedDirectories(value as never),
    collectProductArtifactDirectories: () => collectProductArtifactDirectories(),
    agentSessionVisualizationsDir: (sessionId: string) => agentSessionVisualizationsDir(sessionId),
    isAgentGptImageAvailable: () => true,
    injectVisualizationMcpServer: recordInjector,
    injectAgentPreviewMcpServer: recordInjector,
    injectAgentImageOutputMcpServer: recordInjector,
    injectAgentGptImageMcpServer: recordInjector,
    injectAgentSkinMcpServer: recordInjector,
    injectPptDeliveryMcpServer: recordInjector,
    injectClaudeClipboardMcpServer: recordInjector,
    injectClaudeBrowserMcpServer: recordInjector,
  })

  return async (
    item: AssemblyCase,
    options: {
      state?: CapabilityState
      allowedPresetOperations?: readonly string[]
    } = {},
  ): Promise<OldRunResult> => {
    const state = options.state ?? ACTIVE_RUN
    const policy = resolvedPolicyFor(item)
    const contexts: Record<string, unknown>[] = []
    const events: OldRunResult['events'] = []
    const previewCalls: Array<Record<string, unknown>> = []
    const stoppedBySessions = new Set<string>()
    // 旧链「本轮已取消」= 被显式停止，或本 run 已不是当前代次。
    if (!state.runActive) stoppedBySessions.add(SESSION_ID)
    const runGeneration = 7
    const sessionPermissionModes = new Map<string, string>()
    if (state.planMode || state.sessionPlanMode) sessionPermissionModes.set(SESSION_ID, 'plan')

    await run({
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      modelId: MODEL_ID,
      agentRuntime: 'pi',
      promptMode: 'standard',
      initialPermissionMode: policy.permissionMode,
      workspaceId: item.workspaceSlug ? WORKSPACE_ID : undefined,
      ...(item.workspaceSlug !== undefined ? { workspaceSlug: item.workspaceSlug } : {}),
      ...(item.cwd !== undefined ? { agentCwd: item.cwd } : {}),
      input: { triggeredBy: 'user', goalIteration: undefined, reportGoalResult: undefined },
      disabledToolGroups: new Set(policy.disabledToolGroups),
      disabledTools: policy.disabledTools ? [...policy.disabledTools] : undefined,
      pptCapabilityActive: policy.pptCapabilityActive,
      additionalDirectories: [...ADDITIONAL_DIRECTORIES],
      sessionMeta,
      presetPolicy: { permissionMode: state.planMode ? 'plan' : policy.permissionMode },
      runGeneration,
      allowedPresetOperations: options.allowedPresetOperations ?? [],
      currentPresetReference: undefined,
      userMessage: USER_MESSAGE,
      userConfirmedPresetChange: false,
      pendingPresetChange: undefined,
      piSdk: FIXTURE_SDK,
      sdk: {},
      mcpServers: {},
      self: {
        eventPort: { emit: (sessionId: string, payload: Record<string, unknown>) => events.push({ sessionId, payload }) },
        previewPort: {
          open: async (event: unknown) => { previewCalls.push({ kind: 'open', event }) },
          inspect: async (request: unknown) => { previewCalls.push({ kind: 'inspect', request }) },
        },
        sessionPermissionModes,
        stoppedBySessions,
        activeSessions: new Map([[SESSION_ID, state.runActive ? runGeneration : runGeneration - 1]]),
        buildPiBuiltinTools: async (_piSdk: unknown, context: Record<string, unknown>) => {
          contexts.push(context)
          return { tools: [], collaborationAvailable: false }
        },
      },
    })

    const context = contexts[0]
    if (!context) throw new Error('旧链切片没有调用 buildPiBuiltinTools（切片标记可能失效）')
    return { context, events, previewCalls }
  }
}

// ===== 新路径装配 =====

const baseSlice = sliceBetween(agentServiceSource, BASE_SLICE_START, BASE_SLICE_END, 'base-run-context')
let baseCase: AssemblyCase = cases[0]!
const buildRuntimeHeadlessRunContext = compileSlice<(input: unknown) => Record<string, unknown>>(
  baseSlice,
  'buildRuntimeHeadlessRunContext',
  {
    getAgentSessionMeta: (sessionId: string) => sessionId === SESSION_ID ? sessionMeta : undefined,
    normalizeAgentRuntime,
    getAgentWorkspace: (workspaceId: string) => workspaceId === WORKSPACE_ID
      ? { id: WORKSPACE_ID, slug: baseCase.workspaceSlug }
      : undefined,
    // 无 workspace 时的稳定回退（旧链 `agentCwd = homedir()` 同源）。
    homedir: () => baseCase.cwd,
    getAgentSessionWorkspacePath: (workspaceSlug: string) => workspaceSlug === baseCase.workspaceSlug ? baseCase.cwd : undefined,
    resolveRuntimeHeadlessPolicyContext: () => undefined,
    beginPiCheckpointTurn: () => undefined,
  },
)

/**
 * 两侧共用的**同一份**策略输入：旧链的 `presetPolicy` / `disabledToolGroups` / `pptCapabilityActive`
 * 与新型路径的 `policy` 都由它解析，因此策略维度不参与“产品字段是否一致”的比较。
 *
 * `runtimeSupportsSubagents: true` = Pi 内核支持子 Agent；否则共享策略实现会把 `collaboration`
 * 一并禁用，与旧链 Pi 装配块的事实（`disabledToolGroups` 不含 collaboration）不符。
 */
function policyInputFor(item: AssemblyCase): AgentRuntimePolicyResolutionInput {
  return {
    preset: presetFor(item),
    presetReference: { presetId: 'parity-preset', presetScope: 'user-global' },
    pptCapabilityActive: item.pptCapabilityActive,
    runtimeSupportsSubagents: true,
  }
}

function resolvedPolicyFor(item: AssemblyCase) {
  return resolveAgentRuntimePolicySnapshot(policyInputFor(item)).policy
}

function presetFor(item: AssemblyCase): AgentPreset {
  return {
    id: 'parity-preset',
    name: 'parity preset',
    description: '',
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    permissionMode: 'bypassPermissions',
    disabledToolGroups: [...item.disabledToolGroups],
  } as unknown as AgentPreset
}

interface NewRunResult {
  context: Record<string, unknown>
  events: Array<{ sessionId: string; payload: Record<string, unknown> }>
  previewCalls: Array<Record<string, unknown>>
  /** 注入到装配端口的原始 context（未投影前的字面量）：用于证明旧链路径的 no-op。 */
  rawContext?: unknown
}

interface NewHostShape {
  /** 是否提供事件出口（缺省 true = 生产形态）。无事件出口时可视化 / 生图回调按「能力缺失」处理。 */
  eventBus?: boolean
  /** 是否注入会话可见预览端口（缺省 true）。不注入时预览回调按「能力缺失」处理。 */
  preview?: boolean
}

interface NewRunOptions {
  state?: CapabilityState
  host?: NewHostShape
}

/**
 * 新路径装配：真实入口基座（`buildRuntimeHeadlessRunContext` 切片）→ 真实策略合并
 * （`createRuntimeEntryQuery`）→ 真实准备端口 → 宿主 toolAssembly 端口 → `buildPiBuiltinTools` 记录器。
 *
 * 全程不加载资源 / 不启动 provider：`createAgentQueryPreparationPort({ toolAssembly })` 只做工具装配。
 */
async function runNew(item: AssemblyCase, options: NewRunOptions = {}): Promise<NewRunResult> {
  const state = options.state ?? ACTIVE_RUN
  const shape = options.host ?? {}
  baseCase = item
  const sendInput = {
    sessionId: SESSION_ID,
    channelId: CHANNEL_ID,
    modelId: MODEL_ID,
    agentRuntime: 'pi',
    userMessage: USER_MESSAGE,
    triggeredBy: 'user',
    ...(item.workspaceSlug ? { workspaceId: WORKSPACE_ID } : {}),
    additionalDirectories: [...ADDITIONAL_DIRECTORIES],
  } as unknown as AgentSendInput

  const base = buildRuntimeHeadlessRunContext(sendInput)
  const events: NewRunResult['events'] = []
  const previewCalls: Array<Record<string, unknown>> = []
  const captured: Record<string, unknown>[] = []
  const rawContexts: unknown[] = []

  const toolAssemblyBuild = async (_sdk: unknown, context: unknown) => {
    rawContexts.push(context)
    captured.push(context as Record<string, unknown>)
    return { tools: [], collaborationAvailable: false }
  }

  const withEventBus = shape.eventBus !== false
  const withPreview = shape.preview !== false
  const host = createElectronAgentHost({
    ...(withEventBus
      ? { eventBus: { emit: (sessionId: string, payload: Record<string, unknown>) => events.push({ sessionId, payload }) } as never }
      : {}),
    ...(withPreview
      ? {
          preview: {
            open: async (event: unknown) => { previewCalls.push({ kind: 'open', event }); return {} as never },
            inspect: async (request: unknown) => { previewCalls.push({ kind: 'inspect', request }); return {} as never },
          },
        }
      : {}),
    toolAssemblyBuild,
    productCapabilityDeps: {
      isRuntimeRunActive: () => state.runActive,
      // 与旧链同一判据的两条来源：run 起点进入（presetPolicy）或运行中切换到计划模式。
      isPlanModeActive: () => state.planMode || state.sessionPlanMode === true,
    },
  })

  const entry = createRuntimeEntryQuery(sendInput, {
    runtime: 'pi',
    ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
    toolAssemblyContext: (base.toolAssemblyContext ?? {}) as Record<string, unknown>,
    policy: policyInputFor(item),
    planMode: { emit: () => {} },
  })

  try {
    const preparation = createAgentQueryPreparationPort({ toolAssembly: host.ports.toolAssembly })
    const prepared = await preparation.prepare(entry.query, new AbortController().signal)
    if (!prepared.deferredToolAssembly) throw new Error('新路径没有 deferredToolAssembly（装配端口未接线）')
    await prepared.deferredToolAssembly.build(FIXTURE_SDK)
  } finally {
    agentRuntimePolicyRuns.releaseRun(SESSION_ID)
    clearAgentRuntimeRunFacts(SESSION_ID)
  }

  const context = captured[0]
  if (!context) throw new Error('新路径没有调用装配构建器')
  return { context, events, previewCalls, rawContext: rawContexts[0] }
}

const callError = (fn: (() => void) | undefined): string => {
  if (typeof fn !== 'function') return 'missing'
  try {
    fn()
    return 'no-throw'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const OLD_CANCEL_MESSAGE = '本轮已取消，不能公布可视化'
const OLD_PLAN_MESSAGE = '计划模式不能公布可视化；请先完成计划审批'

// ===== 对照 =====

describe('B8-Pi：Pi 工具装配 context 的产品字段与旧链一致', () => {
  test('切片标记有效（旧链产品块 / browserAllowedRoots / Pi context 字面量 / 新路径基座）', () => {
    const sliceA = sliceBetween(orchestratorSource, SLICE_A_START, SLICE_A_END, 'pi-product-roots')
    expect(sliceA).toContain('const assertCanPresentVisualization = (): void => {')
    expect(sliceA).toContain('const emitVisualizationUpdate = ')
    expect(sliceA).toContain('injectVisualizationMcpServer')
    expect(sliceA).not.toContain('const pluginTools =')
    const sliceB2 = sliceBetween(orchestratorSource, SLICE_B2_START, SLICE_B2_END, 'pi-assembly-context')
    for (const key of ['agentRuntime', 'allowedRoots: browserAllowedRoots', 'visualizationStorageDir', 'onVisualizationUpdate', 'assertCanPresentVisualization', 'onPreviewRequest', 'onPreviewInspectRequest']) {
      expect(sliceB2).toContain(key)
    }
    // 旧链**没有**传 onImageGenerationUpdate：Pi 生图卡片回调从未接线（本文件只用它做差异记录）。
    expect(sliceB2).not.toContain('onImageGenerationUpdate')
    expect(orchestratorSource).not.toContain('onImageGenerationUpdate: emitImageGenerationUpdate')

    const base = sliceBetween(agentServiceSource, BASE_SLICE_START, BASE_SLICE_END, 'base-run-context')
    for (const key of ['sessionId', 'channelId', 'modelId', 'workspaceId', 'workspaceSlug', 'agentCwd', 'permissionMode', 'triggeredBy']) {
      expect(base).toContain(key)
    }
    // 委派子会话的内核继承：旧链在装配 context 里传本会话 runtime，新路径基座必须同样传。
    // 缺它时 `buildPiBuiltinTools` 的委派工具会回落到 'claude'（见其 `?? ctx.agentRuntime`）。
    expect(sliceB2).toContain('agentRuntime,')
    expect(base).toContain('agentRuntime: runtime,')
    expect(entrySource).toContain('buildPolicyToolAssemblyContext(snapshot, options.toolAssemblyContext)')
  })

  test('单格（all-on）：产品字段逐项与旧链同值 / 同行为', async () => {
    const item = cases[0]!
    const old = await buildOldAssembly()(item)
    const next = await runNew(item)

    expect(next.context.allowedRoots).toEqual(old.context.allowedRoots)
    expect(next.context.allowedRoots).toContain(FALLBACK_CWD)
    // 运行级 `additionalDirectories`（不在 PiBuiltinToolsContext 上）必须真的进入授权根：
    // 新路径由宿主 per-run 事实表读取，两侧同值 ⇒ 这条链路被本用例覆盖。
    expect(next.context.allowedRoots).toContain('/parity/attached')
    expect(next.context.visualizationStorageDir).toBe(old.context.visualizationStorageDir)
    expect(typeof next.context.onVisualizationUpdate).toBe('function')
    expect(typeof next.context.assertCanPresentVisualization).toBe('function')
    expect(typeof next.context.onPreviewRequest).toBe('function')
    expect(typeof next.context.onPreviewInspectRequest).toBe('function')

    // 可视化更新广播：两侧载荷逐字相同（同一事件类型 / 同一出口）。
    ;(old.context.onVisualizationUpdate as (record: unknown) => void)(FIXTURE_VISUALIZATION)
    ;(next.context.onVisualizationUpdate as (record: unknown) => void)(FIXTURE_VISUALIZATION)
    expect(next.events).toEqual(old.events)
    expect(next.events[0]?.payload).toMatchObject({ kind: 'profer_event', event: { type: 'visualization_updated', sessionId: SESSION_ID } })

    // 正式文件预览：两侧都把请求交给同一个预览端口（不是新造通道）。
    await (old.context.onPreviewRequest as (event: unknown) => Promise<unknown>)(FIXTURE_PREVIEW_EVENT)
    await (next.context.onPreviewRequest as (event: unknown) => Promise<unknown>)(FIXTURE_PREVIEW_EVENT)
    await (old.context.onPreviewInspectRequest as (request: unknown) => Promise<unknown>)(FIXTURE_INSPECT_REQUEST)
    await (next.context.onPreviewInspectRequest as (request: unknown) => Promise<unknown>)(FIXTURE_INSPECT_REQUEST)
    expect(next.previewCalls).toEqual(old.previewCalls)
    expect(next.previewCalls.map(call => call.kind)).toEqual(['open', 'inspect'])
  })
})

const PRODUCT_TOOL_PATTERNS: readonly RegExp[] = [
  /^send_local_image$/,
  /^generate_image$/,
  /^create_skin$/,
  /^present_visualization$/,
  /^inspect_visualization$/,
  /^open_file_preview$/,
  /^inspect_file_preview$/,
  /^inspect_preview$/,
  /^plan_ppt_visuals$/,
  /^audit_ppt_delivery$/,
  /^clipboard_read_text$/,
  /^clipboard_write_text$/,
  /^Browser/,
]

const isProductTool = (name: string): boolean => PRODUCT_TOOL_PATTERNS.some(pattern => pattern.test(name))

/** 真实 `buildPiBuiltinTools`（fake SDK 只提供 `defineTool`，与既有 parity 用例同法）。 */
async function toolNamesOf(context: Record<string, unknown>): Promise<string[]> {
  const result = await buildPiBuiltinTools(
    { defineTool: (definition: unknown) => definition } as never,
    context as never,
  )
  return result.tools.map(tool => (tool as { name?: string }).name ?? '').filter(Boolean).sort()
}

describe('B8-Pi：矩阵（8 组上下文 × 策略门禁）产品字段与真实工具集逐条一致', () => {
  test('矩阵：被消费的产品字段逐项与旧链同值（含缺 cwd / 缺工作区）', async () => {
    const runOld = buildOldAssembly()
    const rootMismatches: string[] = []
    const storageMismatches: string[] = []
    const callbackMismatches: string[] = []
    const visualizationAbsence: string[] = []
    const scalarMismatches: string[] = []

    for (const item of cases) {
      const old = await runOld(item)
      const next = await runNew(item)
      const oldContext = old.context
      const nextContext = next.context

      if (JSON.stringify(nextContext.allowedRoots) !== JSON.stringify(oldContext.allowedRoots)) {
        rootMismatches.push(`${item.label}: 旧=${JSON.stringify(oldContext.allowedRoots)} 新=${JSON.stringify(nextContext.allowedRoots)}`)
      }
      // 会话 / 工作区 / 权限 / 工具组维度：同一份策略输入下逐项同值。
      for (const key of ['sessionId', 'channelId', 'modelId', 'workspaceId', 'workspaceSlug', 'agentCwd', 'permissionMode', 'triggeredBy', 'pptCapabilityActive']) {
        if (JSON.stringify(nextContext[key] ?? null) !== JSON.stringify(oldContext[key] ?? null)) {
          scalarMismatches.push(`${item.label}.${key}: 旧=${JSON.stringify(oldContext[key] ?? null)} 新=${JSON.stringify(nextContext[key] ?? null)}`)
        }
      }
      const oldGroups = [...(oldContext.disabledToolGroups as Set<string>)].sort()
      const newGroups = [...(nextContext.disabledToolGroups as string[])].sort()
      if (JSON.stringify(oldGroups) !== JSON.stringify(newGroups)) {
        scalarMismatches.push(`${item.label}.disabledToolGroups: 旧=${JSON.stringify(oldGroups)} 新=${JSON.stringify(newGroups)}`)
      }

      if (nextContext.visualizationStorageDir !== oldContext.visualizationStorageDir) {
        storageMismatches.push(`${item.label}: 旧=${String(oldContext.visualizationStorageDir)} 新=${String(nextContext.visualizationStorageDir)}`)
      }

      // 预览回调：与旧链同源同行为（无预览端口的宿主另有专用用例）。
      if (typeof oldContext.onPreviewRequest !== 'function' || typeof nextContext.onPreviewRequest !== 'function') {
        callbackMismatches.push(`${item.label}: onPreviewRequest 缺失（旧=${typeof oldContext.onPreviewRequest} 新=${typeof nextContext.onPreviewRequest}）`)
      } else {
        await (oldContext.onPreviewRequest as (event: unknown) => Promise<unknown>)(FIXTURE_PREVIEW_EVENT)
        await (nextContext.onPreviewRequest as (event: unknown) => Promise<unknown>)(FIXTURE_PREVIEW_EVENT)
        await (oldContext.onPreviewInspectRequest as (request: unknown) => Promise<unknown>)(FIXTURE_INSPECT_REQUEST)
        await (nextContext.onPreviewInspectRequest as (request: unknown) => Promise<unknown>)(FIXTURE_INSPECT_REQUEST)
        if (JSON.stringify(next.previewCalls) !== JSON.stringify(old.previewCalls)) {
          callbackMismatches.push(`${item.label}: 预览载荷不同`)
        }
      }

      const visualizationAvailable = item.workspaceSlug !== undefined && item.cwd !== undefined
      if (visualizationAvailable) {
        if (typeof nextContext.onVisualizationUpdate !== 'function' || typeof nextContext.assertCanPresentVisualization !== 'function') {
          callbackMismatches.push(`${item.label}: 能力可用但可视化回调缺失`)
        } else {
          ;(oldContext.onVisualizationUpdate as (record: unknown) => void)(FIXTURE_VISUALIZATION)
          ;(nextContext.onVisualizationUpdate as (record: unknown) => void)(FIXTURE_VISUALIZATION)
          if (JSON.stringify(next.events) !== JSON.stringify(old.events)) {
            callbackMismatches.push(`${item.label}: 可视化广播载荷不同`)
          }
        }
      } else {
        // 能力缺失（无工作区 / 无 cwd）⇒ 按「不提供」处理：旧链虽传了函数，但
        // `buildPiVisualizationTools` 在缺 storageDir 时永不注册工具，可观察行为相同
        // （由下面的真实工具集对照用例证明）。
        if (nextContext.onVisualizationUpdate !== undefined || nextContext.assertCanPresentVisualization !== undefined) {
          callbackMismatches.push(`${item.label}: 能力缺失却投影了可视化回调`)
        }
        if (oldContext.visualizationStorageDir !== undefined) {
          visualizationAbsence.push(`${item.label}: 旧链 storageDir 非空`)
        }
      }
    }

    expect(scalarMismatches).toEqual([])
    expect(rootMismatches).toEqual([])
    expect(storageMismatches).toEqual([])
    expect(callbackMismatches).toEqual([])
    expect(visualizationAbsence).toEqual([])
  })

  test('矩阵：真实 buildPiBuiltinTools 的**产品工具集**逐条一致（含门禁）', async () => {
    const runOld = buildOldAssembly()
    const mismatches: string[] = []

    for (const item of cases) {
      const old = await runOld(item)
      const next = await runNew(item)
      const oldTools = (await toolNamesOf(old.context)).filter(isProductTool)
      const newTools = (await toolNamesOf(next.context)).filter(isProductTool)
      if (JSON.stringify(oldTools) !== JSON.stringify(newTools)) {
        mismatches.push(`${item.label}: 旧=${JSON.stringify(oldTools)} 新=${JSON.stringify(newTools)}`)
      }
    }

    expect(mismatches).toEqual([])

    // 用例本身必须“真的在比较产品工具”（否则两边都为空会假绿）。
    const allOn = await runNew(cases[0]!)
    const allOnTools = (await toolNamesOf(allOn.context)).filter(isProductTool)
    for (const expected of ['send_local_image', 'generate_image', 'create_skin', 'present_visualization', 'inspect_visualization', 'open_file_preview', 'inspect_file_preview', 'inspect_preview', 'plan_ppt_visuals', 'audit_ppt_delivery', 'clipboard_read_text', 'clipboard_write_text', 'BrowserObserve']) {
      expect(allOnTools).toContain(expected)
    }
    // 缺 cwd / 缺工作区：可视化与图片三件套不注册（与旧链一致）。
    const noCwd = await runNew(cases[1]!)
    const noCwdTools = (await toolNamesOf(noCwd.context)).filter(isProductTool)
    expect(noCwdTools).not.toContain('present_visualization')
    expect(noCwdTools).not.toContain('send_local_image')
    expect(noCwdTools).not.toContain('generate_image')
  })

  test('已知越界缺口（可执行证据）：预设操作字段本任务未关闭，差异不含任何产品工具', async () => {
    const item = cases[0]!
    // 旧链的预设操作集由编排层意图 gate 计算（`evaluateAgentPresetOperationIntents`）；
    // 新路径装配 context 尚无该字段 ⇒ Pi 预设写工具少一组。本任务范围只有产品工具，
    // 故这里把它固定成**显式**差异，而不是留给“字段已加上”的猜测。
    const old = await buildOldAssembly()(item, { allowedPresetOperations: ['create', 'copy', 'propose_update', 'propose_default'] })
    const next = await runNew(item)
    const oldNames = await toolNamesOf(old.context)
    const newNames = await toolNamesOf(next.context)
    const missing = oldNames.filter(name => !newNames.includes(name))
    expect(missing.length).toBeGreaterThan(0)
    expect(missing.every(name => name.startsWith('mcp__agent-presets__'))).toBe(true)
    expect(newNames).toContain('mcp__agent-presets__preset_list')
    // 差异集里没有任何产品工具：本任务关闭的字段已逐条对齐。
    expect(oldNames.filter(isProductTool)).toEqual(newNames.filter(isProductTool))

    // 第二处缺口：`agentRuntime`（旧链传 'pi'，新路径装配 context 原先不传）—— **已关闭**。
    // 缺它时协作 / 委派子会话的内核选择会回落到 'claude'
    // （`agent-collaboration-tools.ts` 的 `ctx.agentRuntime ?? 'claude'`、
    //  `pi-builtin-tools.ts` 的 `a.agentRuntime ?? 'claude'`），
    // 于是 Pi 会话派生的子会话会变成 Claude 会话。它不改变工具名集合，
    // 所以这里比较字段值，而非法比较工具集。
    expect(old.context.agentRuntime).toBe('pi')
    expect(next.context.agentRuntime).toBe('pi')
    expect(oldNames.filter(name => name.startsWith('mcp__collaboration__')))
      .toEqual(newNames.filter(name => name.startsWith('mcp__collaboration__')))
  })
})

describe('B8-Pi：公布门禁同序同文案 / 缺件语义 / 旧链 no-op', () => {
  test('人工审查口径：先判「本轮已取消」再判计划模式，文案与旧链逐字一致', () => {
    // 旧链顺序（`agent-orchestrator.ts` 的 `assertCanPresentVisualization`）：
    //   1. `stoppedBySessions.has(sessionId) || activeSessions.get(sessionId) !== runGeneration` ⇒ 「本轮已取消」
    //   2. `planModeEntered || sessionPermissionModes.get(sessionId) === 'plan'` ⇒ 「计划模式」
    expect(OLD_CANCEL_MESSAGE).toBe('本轮已取消，不能公布可视化')
    expect(OLD_PLAN_MESSAGE).toBe('计划模式不能公布可视化；请先完成计划审批')
  })

  test('四个门禁状态：两侧抛出的文案 / 退出的行为逐条相同（含顺序重叠态）', async () => {
    const runOld = buildOldAssembly()
    const item = cases[0]!
    const states: Array<{ label: string; state: CapabilityState; expected: string }> = [
      { label: '正常运行', state: { runActive: true, planMode: false }, expected: 'no-throw' },
      { label: '本轮已取消', state: { runActive: false, planMode: false }, expected: OLD_CANCEL_MESSAGE },
      { label: 'run 起点即计划模式', state: { runActive: true, planMode: true }, expected: OLD_PLAN_MESSAGE },
      { label: '运行中切到计划模式', state: { runActive: true, planMode: false, sessionPlanMode: true }, expected: OLD_PLAN_MESSAGE },
      { label: '已取消 + 计划模式（顺序重叠态）', state: { runActive: false, planMode: true }, expected: OLD_CANCEL_MESSAGE },
    ]

    for (const { label, state, expected } of states) {
      const old = await runOld(item, { state })
      const next = await runNew(item, { state })
      const oldMessage = callError(old.context.assertCanPresentVisualization as (() => void) | undefined)
      const newMessage = callError(next.context.assertCanPresentVisualization as (() => void) | undefined)
      expect(`${label}: ${oldMessage}`).toBe(`${label}: ${expected}`)
      expect(`${label}: ${newMessage}`).toBe(`${label}: ${oldMessage}`)
    }
  })

  test('缺件语义：没有事件出口 / 预览端口时对应字段「不提供」，不失败也不伪装', async () => {
    const item = cases[0]!
    const bare = await runNew(item, { host: { eventBus: false, preview: false } })

    // 受管浏览器能力由 Electron 主进程自身持有（不需要宿主额外资源）⇒ 授权根仍投影，与旧链一致。
    expect(Array.isArray(bare.context.allowedRoots)).toBe(true)
    expect((bare.context.allowedRoots as string[]).length).toBeGreaterThan(0)
    // 拿不到的能力 = 不提供（键缺失），而不是空实现 / 空回调。
    expect(bare.context.visualizationStorageDir).toBeUndefined()
    expect(bare.context.onVisualizationUpdate).toBeUndefined()
    expect(bare.context.assertCanPresentVisualization).toBeUndefined()
    expect(bare.context.onPreviewRequest).toBeUndefined()
    expect(bare.context.onPreviewInspectRequest).toBeUndefined()

    const tools = await toolNamesOf(bare.context)
    // 可视化工具依赖 storageDir ⇒ 不注册（不伪装成可用）。
    expect(tools).not.toContain('present_visualization')
    expect(tools).not.toContain('inspect_visualization')
    // 其余产品工具仍按各自门禁注册；缺回调时如实失败（不是静默成功）。
    expect(tools).toContain('send_local_image')
    expect(tools).toContain('generate_image')
    expect(tools).toContain('open_file_preview')
    expect(bare.previewCalls).toEqual([])

    // 「已注册但没回调」必须**如实失败**，不得静默成功（与 B8 的 Pi 缺口记录一致）。
    const built = await buildPiBuiltinTools({ defineTool: (definition: unknown) => definition } as never, bare.context as never)
    const openPreview = built.tools.find(tool => (tool as { name?: string }).name === 'open_file_preview') as
      | { execute?(toolCallId: string, params: unknown): Promise<unknown> }
      | undefined
    expect(openPreview?.execute).toBeFunction()
    await expect(openPreview!.execute!('parity-call', { filePath: `${FALLBACK_CWD}/deck.pptx` }))
      .rejects.toThrow('未连接')
  })

  test('旧链路径严格 no-op：已经带齐产品字段的 context 原样透传（关闭开关行为逐字节不变）', async () => {
    const runOld = buildOldAssembly()
    const item = cases[0]!
    const old = await runOld(item)
    const received: unknown[] = []
    const host = createElectronAgentHost({
      eventBus: { emit() {} } as never,
      toolAssemblyBuild: async (_sdk: unknown, context: unknown) => {
        received.push(context)
        return { tools: [], collaborationAvailable: false }
      },
    })
    await host.ports.toolAssembly!.build({ sdk: FIXTURE_SDK, context: old.context })
    // 同一对象引用 ⇒ 没有新增 / 覆盖任何键（投影只补缺失键）。
    expect(received[0]).toBe(old.context)
  })
})
