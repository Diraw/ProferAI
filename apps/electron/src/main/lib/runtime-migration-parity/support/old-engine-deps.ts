/**
 * runtime-migration-parity / 旧引擎依赖注入表
 *
 * 事实来源：本表由"逐步推进 + ReferenceError 发现"实测得到——在 `new Function` 注入模型中，
 * 切片引用的模块级符号缺失时只会在运行到该行时抛 `ReferenceError`，因此"能跑到
 * `adapter.query` 且无 ReferenceError"就是这份依赖表完整的证据。
 *
 * 分层原则：
 * - **真实实现**（真实生产代码，不替换语义）：共享 helper（stream-reader / retry / guards /
 *   preset policy / 工具输入校验 / 提示词模式选择…）。这些是"行为"所在，不能被替身掩盖。
 * - **宿主事实替身**（真实实现需要 Electron / 用户目录 / 配置文件 / 真实 SDK）：settings、
 *   workspace、preset manager、skill 路由、MCP 注入、fs、homedir、权限端口边界。
 *   替换它们是为了**不写磁盘、不联网、不启动 Electron**，并已在 README 中逐条声明。
 * - **显式标注的接缝替换**：见 `SDK_IMPORT_SEAM`。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentProviderAdapter, AgentRuntime, AgentSendInput, AgentSessionMeta, SDKMessage } from '@profer/shared'
import type { CredentialPort } from '@profer/agent-runtime'
import {
  AGENT_PRESET_CAPABILITY_GROUPS,
  AgentSessionRuntimeMismatchError,
  SAFE_TOOLS,
  createEffectiveAgentPresetPolicy,
  inferAgentSdkContextWindow,
  isChannelEnabledForRuntime,
  isEffectiveAgentPresetMcpServerAllowed,
  normalizeAgentRuntime,
  resolveAgentSdk1MSelection,
  withLoadedMcpServerNames,
} from '@profer/shared'
import { createAgentQueryPreparationPort, createAgentRunOwnershipRegistry, createAgentRunOwnershipView, createAgentRunRejectionError, createAgentStreamDrainController, readAgentStreamNext, waitForRetryDelay } from '@profer/agent-runtime'
import { buildAgentSessionUiProjection } from '../../agent-session-ui-projection'
import { AgentRunAlreadyActiveError, applySdkCredentials, isBrowserToolName, isPartialSDKMessage, isPlanModeMarkdownPath, isPlanModeMcpTool, releaseActiveSession, resolvePlanModeBrowserPermission, shouldPreInterruptQueuedMessage, tryAcquireActiveSession, tryReserveQueuedMessage } from '../../agent-orchestrator-p0-guards'
import { createPlanModeToolPolicy } from '../../plan-mode-tool-policy'
import { normalizeAgentEndReason } from '../../agent-end-reason'
// 错误路径诊断：编排层 catch 块用它打印真实错误。
// 注意：不能直接 import `../../agent-orchestrator`（会造成 orchestrator → collaboration-tools →
// agent-service → orchestrator 的模块循环，初始化期 TDZ）；这里用同形的打印替身。
import { formatErrorDetail } from './error-detail-stub'
// GAP-D1：自动命名窗口的共享实现与默认标题常量。
// 旧编排链已改为调用共享模块，切片编译必须注入这两个符号，否则 `autoGenerateTitle` 会在
// 求值处抛 ReferenceError（外层兜底会吞掉，但对照就变成了「旧链根本不跑这段」）。
import { collectSessionTitleSources, runSessionTitleNaming } from '../../agent-session-title-naming'
import { DEFAULT_SESSION_TITLE } from '../../agent-prompt-utils'
import { createElectronPermissionPort } from '../../agent-runtime-permission-port'
import { createCommandExecutionLedger } from '../../pi-execution-ledger'
import { buildPiRuntimeCredentialOptions } from '../../agent-runtime-credentials'
import { resolveCredentialPreflightTypedError } from '../../agent-preflight-typed-errors'
import { buildPiBuiltinTools } from '../../adapters/pi-builtin-tools'
import { buildPiMcpTools as realBuildPiMcpTools, getMcpPolicyToolName } from '../../adapters/pi-mcp-tools'
import { selectAgentPromptMode } from '../../agent-prompt-mode'
import { resolveAgentSystemPromptPolicy } from '../../agent-system-prompt-policy'
import { applyAgentModelRoutingToEnv, resolveAgentModelRouting } from '../../agent-model-routing'
import { validateToolInput, validateToolPathPlatform, validateWriteTargetParent } from '../../agent-tool-input-validator'
import { WRITE_CONTENT_TOKEN_THRESHOLD, estimateTokenCount } from '../../agent-tool-token-estimator'
import { resolvePiThinkingLevel } from '../../agent-thinking-level'
import {
  MAX_AUTO_RETRIES,
  MAX_AUTO_RETRY_WAIT_MS,
  classifyCatchError,
  extractApiError,
  getMaxAutoRetries,
  getRetryDelayMs,
  getRetryDisplayReason,
  isAutoRetryableCatchError,
  isAutoRetryableTypedError,
  isInvalidRelayTokenError,
  isRetryBudgetExhausted,
  isSessionNotFoundError,
  sdkPermissionModeForProferMode,
} from '../../agent-retry-utils'

export interface OldEngineFsRecord {
  writes: Array<{ path: string; bytes: number }>
  mkdirs: string[]
}

export interface OldEngineDepsOptions {
  /** 本轮会话元数据（旧引擎按引用读取，可反映运行中的 updateMeta）。 */
  getSessionMeta: () => AgentSessionMeta | undefined
  getSessionMessages: () => SDKMessage[]
  /** 会话消息追加（同步，与 SessionPort 契约一致）。 */
  appendMessages: (sessionId: string, messages: readonly SDKMessage[]) => void
  updateMeta: (sessionId: string, patch: Partial<AgentSessionMeta>) => void
  lockRuntime: (sessionId: string, runtime: AgentRuntime) => AgentSessionMeta
  channel: { id: string; name?: string; provider: string; enabled: boolean; agentRuntimes: AgentRuntime[]; models: Array<{ id: string; context1m?: boolean | null }> }
  credentialsResolve: () => Promise<Awaited<ReturnType<CredentialPort['resolve']>>>
  eventPortEmit: (sessionId: string, payload: unknown) => void
  permissionPort: Record<string, unknown>
  /** 事件总线（旧引擎构造期 registerCollaborationEventBus 需要）。 */
  eventBus: unknown
  /** fs 记录器（禁止真实磁盘写入）。 */
  fs: OldEngineFsRecord
  /** 重试退避的时间注入点；默认使用真实 `getRetryDelayMs`。 */
  retryDelayMs?: (attempt: number, elapsedMs: number, category: unknown) => number
  /** `routePluginModel` 替身；默认恒等路由，传 `throwError` 复现路由失败。 */
  routePluginModel?: (key: string, input: AgentSendInput, runtime: AgentRuntime) => AgentSendInput
  /** 文件检查点替身（真实实现写盘）。 */
  checkpointPath?: string
  /** 预设替身。 */
  preset?: Record<string, unknown>
  console?: Record<string, unknown>
}

const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} }

/** 构造完整依赖表；`compileSlice` 会把它作为 `new Function` 的形参列表。 */
export function createOldEngineDeps(options: OldEngineDepsOptions): Record<string, unknown> {
  const preset = options.preset ?? {
    id: 'parity-preset',
    name: 'Parity Preset',
    disabledToolGroups: [],
    promptSections: [],
    allowSubagents: false,
  }
  const checkpointPath = options.checkpointPath ?? '/tmp/parity-checkpoint'
  const asyncNoop = async (): Promise<void> => {}
  const noop = (): void => {}
  const listIn = (value: unknown): readonly string[] => Array.isArray(value) ? value.map(String) : []

  return {
    // ── 构造期 / 生命周期：真实守卫 + registry 替身（registry 是宿主单例） ──
    registerCollaborationEventBus: noop,
    setHeadlessAgentRunner: noop,
    setAgentStopper: noop,
    settlePiHarnessRun: noop,
    pauseActivePiHarnessRun: noop,
    startPiHarnessRun: () => undefined,
    stopDelegationsForParent: noop,
    tryAcquireActiveSession,
    releaseActiveSession,
    tryReserveQueuedMessage,
    shouldPreInterruptQueuedMessage,
    AgentRunAlreadyActiveError,
    AgentSessionRuntimeMismatchError,
    normalizeAgentRuntime,
    randomUUID,
    createCommandExecutionLedger,
    serializeErrorDetail: formatErrorDetail,

    // ── 会话 / 渠道 / 凭据（宿主事实） ──
    getAgentSessionMeta: options.getSessionMeta,
    getAgentSessionMessages: options.getSessionMessages,
    getAgentSessionSDKMessages: options.getSessionMessages,
    lockAgentSessionRuntime: options.lockRuntime,
    appendSDKMessages: (sessionId: string, messages: SDKMessage[]) => { options.appendMessages(sessionId, messages) },
    updateAgentSessionMeta: options.updateMeta,
    isAgentSessionForking: () => false,
    getChannelById: () => options.channel,
    isChannelEnabledForRuntime,
    isXaiChannelAvailableForRuntime: () => true,
    resolveRuntimeCredentials: options.credentialsResolve,
    routePluginModel: options.routePluginModel ?? ((_key: string, input: AgentSendInput) => input),
    buildPiRuntimeCredentialOptions,
    MAX_CONTEXT_MESSAGES: 10,
    DEFAULT_MODEL_ID: 'parity-model',
    DEFAULT_SESSION_TITLE,
    // GAP-D1：共享命名模块（真实实现，新链入口也用同一份）。
    runSessionTitleNaming,
    collectSessionTitleSources,
    getSettings: () => ({}),
    getWorkspaceMcpConfig: () => ({ servers: {} }),

    // ── 共享行为（真实实现） ──
    buildAgentSessionUiProjection,
    normalizeAgentEndReason,
    isPartialSDKMessage,
    isBrowserToolName,
    isPlanModeMarkdownPath,
    isPlanModeMcpTool,
    resolvePlanModeBrowserPermission,
    // GAP-5：旧编排层改为 import 共享计划只读策略（切片编译需注入同一实现）。
    createPlanModeToolPolicy,
    applySdkCredentials,
    selectAgentPromptMode,
    resolveAgentSystemPromptPolicy,
    resolveAgentModelRouting,
    applyAgentModelRoutingToEnv,
    resolveAgentSdk1MSelection,
    inferAgentSdkContextWindow,
    createEffectiveAgentPresetPolicy,
    withLoadedMcpServerNames,
    isEffectiveAgentPresetMcpServerAllowed,
    AGENT_PRESET_CAPABILITY_GROUPS,
    SAFE_TOOLS,
    validateToolInput,
    validateToolPathPlatform,
    validateWriteTargetParent,
    estimateTokenCount,
    WRITE_CONTENT_TOKEN_THRESHOLD,
    resolvePiThinkingLevel,
    resolveCredentialPreflightTypedError,
    sdkPermissionModeForProferMode,
    extractApiError,
    isAutoRetryableTypedError,
    isAutoRetryableCatchError,
    isInvalidRelayTokenError,
    isSessionNotFoundError,
    getRetryDelayMs: options.retryDelayMs ?? getRetryDelayMs,
    getRetryDisplayReason,
    getMaxAutoRetries,
    classifyCatchError,
    isRetryBudgetExhausted,
    MAX_AUTO_RETRIES,
    MAX_AUTO_RETRY_WAIT_MS,

    // ── runtime helper（真实实现：新路径也用同一份，正是对照点之一） ──
    readAgentStreamNext,
    createAgentStreamDrainController,
    waitForRetryDelay,
    createAgentQueryPreparationPort,
    createAgentRunOwnershipRegistry,
    createAgentRunOwnershipView,
    createAgentRunRejectionError,
    createElectronPermissionPort: () => options.permissionPort,

    // ── 宿主服务替身（真实实现需要 Electron / 配置文件 / 真实 SDK） ──
    permissionService: { clearSessionPending: noop },
    exitPlanService: { clearSessionPending: noop },
    browserController: { cancelSession: noop, getUserContext: () => undefined },
    agentFilePreviewSessionManager: { waitUntilReady: async () => ({}), inspect: async () => ({}) },
    ensurePresetSystemReady: noop,
    getAgentPresetByReference: () => preset,
    presetReferenceForId: () => ({ presetId: String(preset.id ?? 'parity-preset'), presetScope: 'builtin' as const }),
    evaluatePptCapability: () => ({ active: false }),
    getPendingPresetChange: () => undefined,
    isPresetChangeConfirmation: () => false,
    isPresetChangeCancellation: () => false,
    evaluateAgentPresetOperationIntents: () => [],
    clearPendingPresetChange: noop,
    prepareAgentSkillRouting: async () => ({ snapshot: { skills: [], allowedSlugs: [] } }),
    buildSkillRuntimeOptions: () => ({ additionalSkillPaths: [], skillSlugs: undefined, skillMentions: undefined, skillCatalogPrompt: '', plugins: [], skills: [] }),
    buildSkillRoutingNotice: () => '',
    routeSkillsForTask: (_snapshot: unknown, _input: unknown) => ({ prompt: '', selected: [], recommended: [], hints: [], diagnostics: [] }),
    assembleAgentSystemPrompt: () => ({ systemPrompt: String((preset as Record<string, unknown>).systemPrompt ?? 'parity system prompt'), chars: 20 }),
    buildDynamicContext: () => '',
    buildReferencedSessionsPrompt: () => '',
    buildContextPrompt: (_sessionId: string, message: string) => message,
    detectAttachedDirectoryProjects: () => [],
    collectAttachedDirectories: (input: { extraDirs?: readonly string[] }) => listIn(input?.extraDirs),
    collectProductArtifactDirectories: () => [],
    collectForeignCheckpointPaths: () => [],
    prunePiFileCheckpoints: () => ({ removed: [], removedBound: 0 }),
    createPiFileCheckpoint: () => ({ path: checkpointPath, sessionId: 'parity', capture: asyncNoop, finalize: asyncNoop }),
    mergeRuntimeEnv: (a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) }),
    buildAgentRuntimeEnv: () => ({ shellPath: '/bin/bash', shellKind: 'posix', env: {}, wslCommand: undefined, wslDistro: undefined }),
    getOrCreateShellSnapshot: async () => ({}),
    // 宿主侧 runtimeEnv / SDK env 的唯一实现（`agent-runtime-env-host.ts` / `agent-sdk-env.ts`）：
    // 切片编译不加载真实模块，这里给同形替身，保证旧链走同一条调用路径。
    resolveHostAgentRuntimeEnv: async () => ({ shellPath: '/bin/bash', shellKind: 'posix', env: {}, wslCommand: undefined, wslDistro: undefined }),
    buildAgentSdkEnv: async () => ({ CLAUDE_CONFIG_DIR: '/tmp/parity-sdk', ANTHROPIC_API_KEY: 'parity-key' }),
    getRuntimeStatus: () => undefined,
    shouldStartPiHarness: () => false,
    isAgentGptImageAvailable: () => false,
    buildPiAdditionalDirectoriesPrompt: () => '',
    captureSkillToolInventory: () => ({ sdk: {} }),
    agentSessionVisualizationsDir: () => '/tmp/parity-viz',
    getAgentWorkspace: () => undefined,
    getAgentWorkspacePath: () => '/tmp/parity-ws',
    getAgentSessionWorkspacePath: () => '/tmp/parity-cwd',
    getWorkspaceAutoMemoryDir: () => undefined,
    getWorkspaceMemoryArchivePath: () => '/tmp/parity-memory',
    ensurePluginManifest: noop,
    getSdkConfigDir: () => '/tmp/parity-sdk',
    getPiCheckpointsDir: () => '/tmp/parity-checkpoints',
    getBundledCliPath: () => undefined,
    getEffectiveProxyUrl: async () => undefined,
    // MCP / 工具装配：light 模式不触发；standard 模式由用例注入真实或替身。
    injectAutomationMcpServer: asyncNoop,
    injectMemoryArchiveMcpServer: asyncNoop,
    injectAgentCollaborationMcpServer: asyncNoop,
    injectTaskGraphMcpServer: asyncNoop,
    injectGoalMcpServer: asyncNoop,
    injectAgentPresetMcpServer: asyncNoop,
    injectPlanningMcpServer: asyncNoop,
    injectVisualizationMcpServer: asyncNoop,
    injectAgentPreviewMcpServer: asyncNoop,
    injectAgentImageOutputMcpServer: asyncNoop,
    injectAgentGptImageMcpServer: asyncNoop,
    injectAgentSkinMcpServer: asyncNoop,
    injectPptDeliveryMcpServer: asyncNoop,
    injectClaudeClipboardMcpServer: asyncNoop,
    injectClaudeBrowserMcpServer: asyncNoop,
    buildPluginAgentTools: async () => [],
    buildPiMcpTools: realBuildPiMcpTools,
    getMcpPolicyToolName,
    buildPiBuiltinTools,
    buildPreparedPiTools: () => [],
    preparedPiToolsCollaborationAvailable: () => undefined,
    resolveRecentAutoLinkTaskId: () => null,
    nativeTaskToolToGraphEvents: () => [],
    delegationToGraphEvents: () => [],
    delegationLinkFromResult: () => undefined,
    isDelegateAgentTool: () => false,
    structuredTaskAutoLinkEvent: () => undefined,
    structuredTaskToolCurrentTaskId: () => null,
    appendGraphEvent: noop,
    EMPTY_OUTPUT_ERROR_MESSAGE: 'EMPTY_OUTPUT',
    hasTerminalErrorWithContent: () => false,
    stripErrorFromContentMessage: (message: unknown) => message,

    // ── fs / 路径边界：禁止真实磁盘访问 ──
    existsSync: () => false,
    mkdirSync: (path: string) => { options.fs.mkdirs.push(path) },
    readFileSync: () => '{}',
    writeFileSync: (path: string, content: string | Uint8Array) => {
      options.fs.writes.push({ path, bytes: typeof content === 'string' ? content.length : content.byteLength })
    },
    appendFileSync: (path: string, content: string) => {
      options.fs.writes.push({ path, bytes: content.length })
    },
    homedir: () => '/tmp/parity-home',
    join,
    console: options.console ?? quietConsole,
    eventBus: options.eventBus,
  }
}

export type { AgentProviderAdapter, AgentSendInput }
