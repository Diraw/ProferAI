/**
 * B8 等价性对照：产品 MCP 注入端口 vs **真实旧编排层源码切片**。
 *
 * 与 `agent-runtime-mcp-injection.parity.test.ts` 同一套路：用 `runtime-migration-parity/support/compile-slice.ts`
 * 把**真实旧源码**（`agent-orchestrator.ts` 的第二个 `promptMode === 'standard'` 注入块）编译成可执行函数，
 * 注入记录型注入器，然后在同一个矩阵上比较：
 *
 *   1. **最终注册的服务器集合与顺序**（旧 `Object.keys(mcpServers)` vs 新 `outcome.injected`）；
 *   2. 每个注入器收到的位置参数（上下文 + disabledTools）逐条深比较。
 *
 * 旧侧的三处替身（都不改变被比较的语义）：
 * - `self.eventPort.emit` / `self.previewPort`：只记录调用，不真的投影 / 打开预览；
 * - `collectAttachedDirectories` / `collectProductArtifactDirectories` / `agentSessionVisualizationsDir`：
 *   切片里是模块级符号，按确定性替身注入（两侧用**同一份**替身，因此叶子路径也逐条可比）；
 * - 注入器本身：记录调用，不构造真实 MCP 服务器（构造真实服务器由宿主级测试覆盖）。
 */

import { describe, expect, test } from 'bun:test'
import {
  PRODUCT_MCP_INJECTION_ORDER,
  PRODUCT_MCP_REQUIRED_CAPABILITIES,
  buildProductMcpInjectorArgs,
  composeBrowserAllowedRoots,
  composeImageOutputAllowedRoots,
  composePreviewAllowedRoots,
  createElectronProductMcpInjectionPort,
  missingCapabilities,
  planProductMcpServers,
  runProductMcpInjection,
  type ProductMcpHostCapabilities,
  type ProductMcpInjectionContext,
  type ProductMcpInjector,
  type ProductMcpPlanInput,
  type ProductMcpServerId,
  type ProductRootInputs,
} from './agent-runtime-product-mcp-injection'
import type { ClaudeSdkNamespace, McpServerTable } from './agent-runtime-mcp-injection'
import { compileSlice, readMainSource, sliceBetween } from './runtime-migration-parity/support/compile-slice'

const orchestratorSource = readMainSource('agent-orchestrator.ts')

const SLICE_START = '// 本地图片输出只在受工作区授权的会话注册'
const SLICE_END = 'const pluginTools = promptMode === \'light\' ? [] : await buildPluginAgentTools('

/** 记录一次注入器调用：id + 去掉 sdk/mcpServers 后的位置参数。 */
interface InjectionCall {
  id: ProductMcpServerId
  args: readonly unknown[]
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * 记录型注入器。
 *
 * `agent-skin` 在缺少 `agentCwd` / `workspaceSlug` 时会**提前 return**（不注册服务器），
 * 因此记录器照同一语义判断 `registered`，否则会高估旧链的可见能力。
 */
function makeRecorder(log: InjectionCall[]) {
  return (id: ProductMcpServerId) => async (...callArgs: readonly unknown[]): Promise<void> => {
    const mcpServers = callArgs[1] as McpServerTable
    const args = callArgs.slice(2)
    log.push({ id, args })
    if (id === 'agent-skin') {
      const ctx = args[0] as { agentCwd?: string; workspaceSlug?: string } | undefined
      if (!ctx?.agentCwd || !ctx?.workspaceSlug) return
    }
    mcpServers[id] = { registered: true }
  }
}

/** 两侧共用的固定事实（sessionId / workspaceId / 单工具禁用），与矩阵维度正交。 */
const SHARED = {
  sessionId: 'parity-session',
  workspaceId: 'parity-workspace',
  disabledTools: ['WebSearch'],
}

/**
 * 两侧共用的**目录采集**替身。
 *
 * 采样粒度刻意与旧链一致：`collectAttachedDirectories` 返回附加目录（不含会话 cwd，也不含产品产物目录），
 * 产品产物目录由 `collectProductArtifactDirectories` 单独追加 —— 只有这样，
 * “cwd 前缀 / 附加目录 / 产物目录 / 去重”这四条组合规则才会真的被比较到。
 */
const ATTACHED_DIRECTORIES_STUB = ['/parity/attached']
const PRODUCT_ARTIFACT_DIRECTORIES_STUB = ['/parity/product-artifacts']
const VISUALIZATION_STORAGE_STUB = '/parity/visualizations/parity-session'

function oldRootInputs(item: { agentCwd: string | undefined; workspaceSlug: string | undefined }): ProductRootInputs {
  return {
    ...(item.agentCwd !== undefined ? { agentCwd: item.agentCwd } : {}),
    workspaceId: SHARED.workspaceId,
    ...(item.workspaceSlug !== undefined ? { workspaceSlug: item.workspaceSlug } : {}),
    attachedDirectories: ATTACHED_DIRECTORIES_STUB,
    productArtifactDirectories: PRODUCT_ARTIFACT_DIRECTORIES_STUB,
  }
}

const PREVIEW_ROOTS_STUB = composePreviewAllowedRoots(oldRootInputs({ agentCwd: '/parity/session-cwd', workspaceSlug: 'ws-a' }))
const BROWSER_ROOTS_STUB = composeBrowserAllowedRoots(oldRootInputs({ agentCwd: '/parity/session-cwd', workspaceSlug: 'ws-a' }))

/** 旧侧依赖表：模块级符号由切片编译注入。 */
function oldDeps(log: InjectionCall[]) {
  const record = makeRecorder(log)
  return {
    collectAttachedDirectories: () => [...ATTACHED_DIRECTORIES_STUB],
    collectProductArtifactDirectories: () => [...PRODUCT_ARTIFACT_DIRECTORIES_STUB],
    agentSessionVisualizationsDir: () => VISUALIZATION_STORAGE_STUB,
    isAgentGptImageAvailable: () => true,
    injectVisualizationMcpServer: record('visualization'),
    injectAgentPreviewMcpServer: record('agent-preview'),
    injectAgentImageOutputMcpServer: record('agent-image-output'),
    injectAgentGptImageMcpServer: record('agent-gpt-image'),
    injectAgentSkinMcpServer: record('agent-skin'),
    injectPptDeliveryMcpServer: record('ppt-delivery'),
    injectClaudeClipboardMcpServer: record('clipboard'),
    injectClaudeBrowserMcpServer: record('browser'),
  }
}

/** 新侧注入器覆盖表：与旧侧同一批记录函数，只是键名换成端口 id。 */
function newInjectorOverrides(log: InjectionCall[]): Partial<Record<ProductMcpServerId, ProductMcpInjector>> {
  const record = makeRecorder(log)
  const overrides: Partial<Record<ProductMcpServerId, ProductMcpInjector>> = {}
  for (const id of PRODUCT_MCP_INJECTION_ORDER) {
    overrides[id] = record(id) as ProductMcpInjector
  }
  return overrides
}

interface MatrixCase {
  label: string
  promptMode: 'light' | 'standard'
  runtime: 'claude' | 'pi'
  disabledToolGroups: readonly string[]
  workspaceSlug: string | undefined
  agentCwd: string | undefined
  pptCapabilityActive: boolean
}

const matrix: MatrixCase[] = []
for (const promptMode of ['standard', 'light'] as const) {
  for (const runtime of ['claude', 'pi'] as const) {
    for (const disabledToolGroups of [[], ['preview'], ['image'], ['clipboard'], ['browser'], ['ppt-materials'], ['image', 'browser'], ['preview', 'clipboard', 'browser']] as const) {
      for (const workspaceSlug of ['ws-a', undefined]) {
        for (const agentCwd of ['/parity/session-cwd', undefined]) {
          for (const pptCapabilityActive of [true, false]) {
            matrix.push({
              label: `${promptMode}/${runtime}/[${disabledToolGroups.join(',')}]/${workspaceSlug ?? 'no-ws'}/${agentCwd ?? 'no-cwd'}/ppt:${pptCapabilityActive}`,
              promptMode,
              runtime,
              disabledToolGroups,
              workspaceSlug,
              agentCwd,
              pptCapabilityActive,
            })
          }
        }
      }
    }
  }
}

function buildOldAssembly() {
  const log: InjectionCall[] = []
  const deps = oldDeps(log)
  const slice = sliceBetween(orchestratorSource, SLICE_START, SLICE_END, 'product-mcp-injection')
  const sharedMcpServers: McpServerTable = {}
  const wrapper = [
    'async function runOldProductMcpAssembly(ctx) {',
    '  const {',
    '    promptMode, sessionId, workspaceSlug, workspaceId, agentCwd, agentRuntime, input,',
    '    disabledToolGroups, disabledTools, pptCapabilityActive, additionalDirectories, sessionMeta,',
    '    presetPolicy, runGeneration, self,',
    '  } = ctx',
    // `this.` 是旧方法里的编排器实例引用；切片编译后没有 this，统一绑定到 self 替身。
    slice.replace(/\bthis\./g, 'self.'),
    '  return mcpServers',
    '}',
  ].join('\n')

  const run = compileSlice<(ctx: Record<string, unknown>) => Promise<McpServerTable>>(
    wrapper,
    'runOldProductMcpAssembly',
    // `sdk` / `mcpServers` 在旧链里是方法体内的局部量；本切片把它们变成注入依赖，
    // 并在每次用例前清空 `sharedMcpServers`，保证「旧链最终表」不跨用例累积。
    { ...deps, sdk: {}, mcpServers: sharedMcpServers },
  )

  const execute = async (item: MatrixCase): Promise<{ mcpServers: McpServerTable; calls: readonly InjectionCall[] }> => {
    for (const key of Object.keys(sharedMcpServers)) delete sharedMcpServers[key]
    const logStart = log.length
    await run({
      promptMode: item.promptMode,
      sessionId: SHARED.sessionId,
      workspaceSlug: item.workspaceSlug,
      workspaceId: SHARED.workspaceId,
      agentCwd: item.agentCwd,
      agentRuntime: item.runtime,
      input: { triggeredBy: 'user' },
      disabledToolGroups: new Set(item.disabledToolGroups),
      disabledTools: SHARED.disabledTools,
      pptCapabilityActive: item.pptCapabilityActive,
      additionalDirectories: undefined,
      sessionMeta: undefined,
      // 旧链在公布可视化时会读这三个编排器私有状态；本对照不触发 assertCanPresent，只保证可求值。
      presetPolicy: { permissionMode: 'auto' },
      runGeneration: 1,
      self: {
        eventPort: { emit: () => {} },
        previewPort: { open: async () => undefined, inspect: async () => undefined },
        sessionPermissionModes: new Map<string, string>(),
        stoppedBySessions: new Set<string>(),
        activeSessions: new Map<string, number>(),
      },
    })
    return { mcpServers: { ...sharedMcpServers }, calls: log.slice(logStart) }
  }

  return { execute }
}

/** 规范用例（参数构造 / 能力缺失等单点的基准，与矩阵里 “全开” 一格同形）。 */
const CANONICAL_CASE: MatrixCase = {
  label: 'standard/claude/all-on',
  promptMode: 'standard',
  runtime: 'claude',
  disabledToolGroups: [],
  workspaceSlug: 'ws-a',
  agentCwd: '/parity/session-cwd',
  pptCapabilityActive: true,
}

/**
 * 新侧宿主能力：目录采集用与旧侧**同一份替身**，组合规则调用**生产函数**（不手写第二份）。
 *
 * 能力的存在性与宿主内实现一致：`image-output-roots` 只在组合结果非空时提供。
 */
function newCapabilities(item: MatrixCase = CANONICAL_CASE): ProductMcpHostCapabilities {
  const roots = oldRootInputs(item)
  const previewRoots = composePreviewAllowedRoots(roots)
  const imageRoots = composeImageOutputAllowedRoots(roots)
  const capabilities: ProductMcpHostCapabilities = {
    visualization: {
      storageDir: VISUALIZATION_STORAGE_STUB,
      allowedRoots: previewRoots,
      onUpdate: () => {},
      assertCanPresent: () => {},
    },
    'file-preview': {
      allowedRoots: previewRoots,
      open: async () => ({}) as never,
      inspect: async () => ({}) as never,
    },
    'ai-image-generation': { isGptImageAvailable: () => true, onGenerationUpdate: () => {} },
    clipboard: true,
    browser: { allowedRoots: composeBrowserAllowedRoots(roots) },
  }
  if (imageRoots.length > 0) capabilities['image-output-roots'] = { allowedRoots: imageRoots }
  return capabilities
}

function buildNewPort() {
  const log: InjectionCall[] = []
  const port = createElectronProductMcpInjectionPort({ injectors: newInjectorOverrides(log) })
  return { port, log }
}

function newContext(item: MatrixCase): ProductMcpInjectionContext {
  return {
    sessionId: SHARED.sessionId,
    workspaceId: SHARED.workspaceId,
    ...(item.workspaceSlug !== undefined ? { workspaceSlug: item.workspaceSlug } : {}),
    ...(item.agentCwd !== undefined ? { agentCwd: item.agentCwd } : {}),
    triggeredBy: 'user',
    disabledTools: SHARED.disabledTools,
  }
}

function newPlanInput(item: MatrixCase): ProductMcpPlanInput {
  return {
    promptMode: item.promptMode,
    runtime: item.runtime,
    disabledToolGroups: item.disabledToolGroups,
    hasWorkspace: item.workspaceSlug !== undefined,
    hasSessionCwd: item.agentCwd !== undefined,
    pptCapabilityActive: item.pptCapabilityActive,
  }
}

describe('B8 等价性：产品服务器最终注入集合 / 顺序 / 参数与旧链逐条一致', () => {
  test('切片标记有效（起点与终点都命中真实源码，且不含内置 7 服务器块）', () => {
    const slice = sliceBetween(orchestratorSource, SLICE_START, SLICE_END, 'product-mcp-injection')
    expect(slice).toContain('await injectVisualizationMcpServer(')
    expect(slice).toContain('await injectClaudeBrowserMcpServer(')
    expect(slice).not.toContain('injectAutomationMcpServer')
  })

  test(`矩阵（${matrix.length} 组）两侧最终服务器集合与顺序一致`, async () => {
    const { execute } = buildOldAssembly()
    const mismatches: string[] = []

    for (const item of matrix) {
      const old = await execute(item)
      const oldInjected = Object.keys(old.mcpServers)
      const { port } = buildNewPort()
      const outcome = await runProductMcpInjection(port, {
        context: newContext(item),
        mcpServers: {},
        sdk: {} as ClaudeSdkNamespace,
        planInput: newPlanInput(item),
        capabilities: newCapabilities(item),
      })
      if (JSON.stringify(oldInjected) !== JSON.stringify(outcome.injected)) {
        mismatches.push(`${item.label}: 旧=${JSON.stringify(oldInjected)} 新=${JSON.stringify(outcome.injected)}`)
      }
    }

    expect(mismatches).toEqual([])
  })

  test(`矩阵（${matrix.length} 组）两侧注入器收到的位置参数逐条一致`, async () => {
    const { execute } = buildOldAssembly()
    const mismatches: string[] = []

    for (const item of matrix) {
      const old = await execute(item)
      const { port, log } = buildNewPort()
      const outcome = await runProductMcpInjection(port, {
        context: newContext(item),
        mcpServers: {},
        sdk: {} as ClaudeSdkNamespace,
        planInput: newPlanInput(item),
        capabilities: newCapabilities(item),
      })
      // 只比较**实际注册**的调用：旧链里唯一「调用了但不注册」的是缺上下文的 agent-skin。
      const oldRegistered = new Set(Object.keys(old.mcpServers))
      const oldCalls = old.calls
        .filter(call => oldRegistered.has(call.id))
        .map(call => ({ id: call.id, args: normalize(call.args) }))
      const newInjected = new Set(outcome.injected)
      const newCalls = log
        .filter(call => newInjected.has(call.id))
        .map(call => ({ id: call.id, args: normalize(call.args) }))
      if (JSON.stringify(oldCalls) !== JSON.stringify(newCalls)) {
        mismatches.push(`${item.label}:\n  旧=${JSON.stringify(oldCalls)}\n  新=${JSON.stringify(newCalls)}`)
      }
      const oldNoop = old.calls.filter(call => !oldRegistered.has(call.id)).map(call => call.id)
      if (oldNoop.some(id => id !== 'agent-skin')) {
        mismatches.push(`${item.label}: 旧链出现了非预期空调用 ${JSON.stringify(oldNoop)}`)
      }
      if (outcome.unavailable.length > 0) {
        mismatches.push(`${item.label}: 完整宿主能力下仍有不可用条目 ${JSON.stringify(outcome.unavailable)}`)
      }
    }

    expect(mismatches).toEqual([])
  })

  test('规划顺序与旧链一致：visualization → preview → image-output → gpt-image → skin → ppt-delivery → clipboard → browser', () => {
    expect(planProductMcpServers({
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      hasWorkspace: true,
      hasSessionCwd: true,
      pptCapabilityActive: true,
    }).map(entry => entry.id)).toEqual([
      'visualization',
      'agent-preview',
      'agent-image-output',
      'agent-gpt-image',
      'agent-skin',
      'ppt-delivery',
      'clipboard',
      'browser',
    ] as const)
    expect([...PRODUCT_MCP_INJECTION_ORDER]).toHaveLength(8)
  })

  test('旧链启用条件逐条：disabling 某一组只影响该组服务器（不牵连其它组）', () => {
    const full: ProductMcpPlanInput = {
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      hasWorkspace: true,
      hasSessionCwd: true,
      pptCapabilityActive: true,
    }
    const enabledOf = (input: Partial<ProductMcpPlanInput>) => planProductMcpServers({ ...full, ...input })
      .filter(entry => entry.enabled)
      .map(entry => entry.id)

    expect(enabledOf({})).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
    // preview 组禁用：visualization 与 agent-preview 同时消失（同组）。
    expect(enabledOf({ disabledToolGroups: ['preview'] })).toEqual([
      'agent-image-output', 'agent-gpt-image', 'agent-skin', 'ppt-delivery', 'clipboard', 'browser',
    ])
    // image 组禁用：三个图片服务器同时消失（嵌套块）。
    expect(enabledOf({ disabledToolGroups: ['image'] })).toEqual([
      'visualization', 'agent-preview', 'ppt-delivery', 'clipboard', 'browser',
    ])
    // clipboard / browser 各自独立。
    expect(enabledOf({ disabledToolGroups: ['clipboard'] })).not.toContain('clipboard')
    expect(enabledOf({ disabledToolGroups: ['clipboard'] })).toContain('browser')
    expect(enabledOf({ disabledToolGroups: ['browser'] })).not.toContain('browser')
    expect(enabledOf({ disabledToolGroups: ['browser'] })).toContain('clipboard')
    // ppt-materials 组不影响任何产品服务器（门禁已收敛进 pptCapabilityActive）。
    expect(enabledOf({ disabledToolGroups: ['ppt-materials'] })).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
    // runtime 为 pi：只剩 image-output 与 ppt-delivery（旧链里两者没有 claude 门禁）。
    expect(enabledOf({ runtime: 'pi' })).toEqual(['agent-image-output', 'ppt-delivery'])
    // light：整块跳过。
    expect(enabledOf({ promptMode: 'light' })).toEqual([])
    // 无工作区：visualization / 图片三件套消失；agent-preview 仍在（旧链不要求工作区）。
    expect(enabledOf({ hasWorkspace: false })).toEqual([
      'agent-preview', 'ppt-delivery', 'clipboard', 'browser',
    ])
    // 无会话工作目录：visualization / 图片三件套消失。
    expect(enabledOf({ hasSessionCwd: false })).toEqual([
      'agent-preview', 'ppt-delivery', 'clipboard', 'browser',
    ])
    // PPT 门禁关：ppt-delivery 消失，其余不受影响。
    expect(enabledOf({ pptCapabilityActive: false })).not.toContain('ppt-delivery')
  })

  test('buildProductMcpInjectorArgs 是参数构造的唯一来源（端口 inject 复用它）', async () => {
    const item: MatrixCase = {
      label: 'standard/claude/all-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      agentCwd: '/parity/session-cwd',
      pptCapabilityActive: true,
    }
    const request = {
      context: newContext(item),
      mcpServers: {},
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(item),
      capabilities: newCapabilities(),
    }
    // 函数值经 JSON 序列化后不参与比较（两侧都是函数，无法也不应比较身份）。
    expect(normalize(await buildProductMcpInjectorArgs('visualization', request))).toEqual([{
      sessionId: 'parity-session',
      agentCwd: '/parity/session-cwd',
      storageDir: VISUALIZATION_STORAGE_STUB,
      allowedRoots: PREVIEW_ROOTS_STUB,
    }, ['WebSearch']])
    // preview 在没有工作区时显式给空串（不把 homedir 当预览根）；有工作区时用真实 cwd。
    const withWorkspace = await buildProductMcpInjectorArgs('agent-preview', request)
    expect((withWorkspace[0] as { agentCwd: string }).agentCwd).toBe('/parity/session-cwd')
    const withoutWorkspace = await buildProductMcpInjectorArgs('agent-preview', {
      ...request,
      context: { ...request.context, workspaceSlug: undefined },
    })
    expect((withoutWorkspace[0] as { agentCwd: string }).agentCwd).toBe('')
    expect(normalize(withoutWorkspace[1])).toEqual(['WebSearch'])
    // browser 的 disabledTools 是上下文字段，不是第 5 个位置参数。
    expect(normalize(await buildProductMcpInjectorArgs('browser', request))).toEqual([{
      sessionId: 'parity-session',
      workspaceId: 'parity-workspace',
      agentCwd: '/parity/session-cwd',
      allowedRoots: BROWSER_ROOTS_STUB,
      executionSource: 'user',
      disabledTools: ['WebSearch'],
    }])
  })

  test('缺宿主能力：逐条记为 capability-missing，不调用注入器、不写任何服务器（不静默放行）', async () => {
    const item: MatrixCase = {
      label: 'standard/claude/all-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      agentCwd: '/parity/session-cwd',
      pptCapabilityActive: true,
    }
    const { port, log } = buildNewPort()
    const outcome = await runProductMcpInjection(port, {
      context: newContext(item),
      mcpServers: {},
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(item),
      capabilities: {},
    })
    // ppt-delivery 不需要宿主资源，因此仍然注入；其余 7 条全部按能力缺失记录。
    expect(outcome.injected).toEqual(['ppt-delivery'])
    expect(log.map(call => call.id)).toEqual(['ppt-delivery'])
    expect(outcome.unavailable.map(entry => [entry.id, entry.reason])).toEqual([
      ['visualization', 'capability-missing'],
      ['agent-preview', 'capability-missing'],
      ['agent-image-output', 'capability-missing'],
      ['agent-gpt-image', 'capability-missing'],
      ['agent-skin', 'capability-missing'],
      ['clipboard', 'capability-missing'],
      ['browser', 'capability-missing'],
    ])
    expect(outcome.unavailable[0]?.detail).toBe('visualization')
    expect(outcome.skipped).toEqual([])
    // 能力声明表本身可静态核对：缺哪个能力由 getter 给出，而不是靠调用点各自判断。
    expect(missingCapabilities('agent-gpt-image', {})).toEqual(['image-output-roots', 'ai-image-generation'])
    expect(missingCapabilities('agent-gpt-image', { 'image-output-roots': { allowedRoots: [] } })).toEqual(['ai-image-generation'])
    expect(PRODUCT_MCP_REQUIRED_CAPABILITIES['ppt-delivery']).toEqual([])
  })

  test('AI 生图探测为假：只该条记为 capability-unavailable，其余继续注入（不整体失败）', async () => {
    const item: MatrixCase = {
      label: 'standard/claude/all-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      agentCwd: '/parity/session-cwd',
      pptCapabilityActive: true,
    }
    const capabilities = newCapabilities()
    capabilities['ai-image-generation'] = { isGptImageAvailable: () => false, onGenerationUpdate: () => {} }
    const { port } = buildNewPort()
    const outcome = await runProductMcpInjection(port, {
      context: newContext(item),
      mcpServers: {},
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(item),
      capabilities,
    })
    expect(outcome.injected).toEqual(['visualization', 'agent-preview', 'agent-image-output', 'agent-skin', 'ppt-delivery', 'clipboard', 'browser'])
    expect(outcome.unavailable).toEqual([{ id: 'agent-gpt-image', reason: 'capability-unavailable', detail: 'ai-image-generation' }])
  })

  test('端口缺失 / 单条注入抛错 / 静默无产物：三种失败语义互不混淆', async () => {
    const item: MatrixCase = {
      label: 'standard/claude/all-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      agentCwd: '/parity/session-cwd',
      pptCapabilityActive: true,
    }
    const base = {
      context: newContext(item),
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(item),
      capabilities: newCapabilities(),
    }

    const noPort = await runProductMcpInjection(undefined, { ...base, mcpServers: {} })
    expect(noPort.portAvailable).toBe(false)
    expect(noPort.injected).toEqual([])
    expect(noPort.unavailable.every(entry => entry.reason === 'port-missing')).toBe(true)
    expect(noPort.skipped).toEqual([])

    const throwingPort = createElectronProductMcpInjectionPort({
      injectors: {
        ...newInjectorOverrides([]),
        browser: async () => { throw new Error('injector boom') },
      },
    })
    const failed = await runProductMcpInjection(throwingPort, { ...base, mcpServers: {} })
    expect(failed.unavailable).toEqual([{ id: 'browser', reason: 'injector-failed', detail: 'injector boom' }])
    expect(failed.injected).not.toContain('browser')
    expect(failed.injected).toContain('clipboard')

    // 注入器正常返回但没有写表：必须记 injector-noop，不能当成已注入。
    const noopPort = createElectronProductMcpInjectionPort({
      injectors: {
        ...newInjectorOverrides([]),
        clipboard: async () => {},
      },
    })
    const noop = await runProductMcpInjection(noopPort, { ...base, mcpServers: {} })
    expect(noop.unavailable).toEqual([{ id: 'clipboard', reason: 'injector-noop' }])
    expect(noop.injected).not.toContain('clipboard')
  })

  test('默认端口：确实接线到生产注入器（不是空实现）', async () => {
    const port = createElectronProductMcpInjectionPort()
    const item: MatrixCase = {
      label: 'standard/claude/all-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      agentCwd: '/parity/session-cwd',
      pptCapabilityActive: true,
    }
    const mcpServers: McpServerTable = {}
    const outcome = await runProductMcpInjection(port, {
      context: newContext(item),
      mcpServers,
      sdk: (await import('@anthropic-ai/claude-agent-sdk')) as ClaudeSdkNamespace,
      planInput: newPlanInput(item),
      capabilities: newCapabilities(),
    })
    // 真实注入器会用真实键名写表；这里只断言「八条都真的注册了」，构造细节由注入器自身测试覆盖。
    expect(outcome.injected).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
    expect(Object.keys(mcpServers)).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
  })

  test('同名服务器：产品注入在旧链里同样会覆盖外部/工作区同名 MCP（不是「外部优先」）', async () => {
    const enabledCase: MatrixCase = {
      label: 'standard/claude/clipboard-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      agentCwd: '/parity/session-cwd',
      pptCapabilityActive: false,
    }
    const external: McpServerTable = { clipboard: { type: 'stdio', command: 'external' } }
    const { port } = buildNewPort()
    const outcome = await runProductMcpInjection(port, {
      context: newContext(enabledCase),
      mcpServers: external,
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(enabledCase),
      capabilities: newCapabilities(),
    })
    expect(outcome.injected).toContain('clipboard')
    expect(external.clipboard).toEqual({ registered: true })

    // 预设禁用 clipboard 时：产品服务器不注入，同名外部 MCP 原样保留（由白名单/工具装配继续管辖）。
    const disabledCase: MatrixCase = { ...enabledCase, disabledToolGroups: ['clipboard'] }
    const preserved: McpServerTable = { clipboard: { type: 'stdio', command: 'external' } }
    await runProductMcpInjection(port, {
      context: newContext(disabledCase),
      mcpServers: preserved,
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(disabledCase),
      capabilities: newCapabilities(),
    })
    expect(preserved.clipboard).toEqual({ type: 'stdio', command: 'external' })
  })
})
