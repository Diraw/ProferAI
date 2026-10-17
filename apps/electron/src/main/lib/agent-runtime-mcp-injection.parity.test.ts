/**
 * GAP-4 等价性对照：新注入端口 vs **真实旧编排层源码切片**。
 *
 * 为什么用源码切片而不是复述规则：旧链的注入条件写在 `agent-orchestrator.ts` 的方法体里，
 * 复制一份条件表无法证明「一致」，只能证明「两份复制互相相等」。
 * 这里用 `runtime-migration-parity/support/compile-slice.ts`（既有设施）把
 * **真实旧源码**编译成可执行函数，注入记录型注入器，然后在同一个矩阵上比较：
 *
 *   1. 最终注入的服务器集合与顺序（`Object.keys(mcpServers)` vs `outcome.injected`）；
 *   2. 每个注入器收到的位置参数（上下文 + disabledTools）逐条深比较。
 *
 * 旧侧唯一的两处替身（都不改变被比较的语义）：
 * - `self.buildMcpServers`：旧链里负责「工作区用户 MCP」，本批由 resource port 承担，
 *   因此主矩阵里返回空表，使 `mcpServers` 只剩内置服务器；另有一条用例带外部 MCP 证明两者互不覆盖。
 * - 注入器本身：记录调用，不构造真实 MCP 服务器（构造真实服务器由单元测试覆盖）。
 */

import { describe, expect, test } from 'bun:test'
import { withLoadedMcpServerNames } from '@profer/shared'
import {
  BUILTIN_MCP_INJECTION_ORDER,
  buildBuiltinMcpInjectorArgs,
  createElectronBuiltinMcpInjectionPort,
  planBuiltinMcpServers,
  runBuiltinMcpInjection,
  type BuiltinMcpInjectionContext,
  type BuiltinMcpInjector,
  type BuiltinMcpPlanInput,
  type BuiltinMcpServerId,
  type ClaudeSdkNamespace,
  type McpServerTable,
} from './agent-runtime-mcp-injection'
import { compileSlice, readMainSource, sliceBetween } from './runtime-migration-parity/support/compile-slice'

const orchestratorSource = readMainSource('agent-orchestrator.ts')

const SLICE_START = "const mcpServers = promptMode === 'light' ? {} : this.buildMcpServers("
const SLICE_END = '// 本地图片输出只在受工作区授权的会话注册'

/** 记录一次注入器调用：id + 去掉 sdk/mcpServers 后的位置参数 + 是否真的注册了服务器。 */
interface InjectionCall {
  id: BuiltinMcpServerId
  args: readonly unknown[]
  registered: boolean
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * 记录型注入器。
 *
 * `memory-archive` 在旧链里缺少路径时会**提前 return**（不注册任何服务器），
 * 因此记录器也照这个语义判断 `registered`，否则会高估旧链的可见能力。
 */
function makeRecorder(log: InjectionCall[]) {
  return (id: BuiltinMcpServerId) => async (...callArgs: readonly unknown[]): Promise<void> => {
    const mcpServers = callArgs[1] as McpServerTable
    const args = callArgs.slice(2)
    const registered = id === 'memory-archive'
      ? Boolean((args[0] as { memoryArchivePath?: string } | undefined)?.memoryArchivePath)
      : true
    log.push({ id, args, registered })
    if (registered) mcpServers[id] = { registered: true }
  }
}

/** 旧侧依赖表：模块级符号由切片编译注入。 */
function oldDeps(log: InjectionCall[]) {
  const record = makeRecorder(log)
  return {
    withLoadedMcpServerNames,
    injectAutomationMcpServer: record('automation'),
    injectMemoryArchiveMcpServer: record('memory-archive'),
    injectAgentCollaborationMcpServer: record('collaboration'),
    injectTaskGraphMcpServer: record('task-graph'),
    injectGoalMcpServer: record('goal'),
    injectAgentPresetMcpServer: record('agent-presets'),
    injectPlanningMcpServer: record('planning'),
    getWorkspaceMemoryArchivePath: (workspaceSlug: string) => `/parity/${workspaceSlug}/.context/memory-archive`,
  }
}

/** 新侧注入器覆盖表：与旧侧同一批记录函数，只是键名换成端口 id。 */
function newInjectorOverrides(log: InjectionCall[]): Partial<Record<BuiltinMcpServerId, BuiltinMcpInjector>> {
  const record = makeRecorder(log)
  const overrides: Partial<Record<BuiltinMcpServerId, BuiltinMcpInjector>> = {}
  for (const id of BUILTIN_MCP_INJECTION_ORDER) {
    overrides[id] = record(id) as BuiltinMcpInjector
  }
  return overrides
}

interface MatrixCase {
  label: string
  promptMode: 'light' | 'standard'
  runtime: 'claude' | 'pi'
  disabledToolGroups: readonly string[]
  workspaceSlug: string | undefined
  reportGoalResult: boolean
}

const matrix: MatrixCase[] = []
for (const promptMode of ['standard', 'light'] as const) {
  for (const runtime of ['claude', 'pi'] as const) {
    for (const disabledToolGroups of [[], ['automation'], ['memory'], ['collaboration'], ['task-graph'], ['automation', 'memory', 'task-graph']] as const) {
      for (const workspaceSlug of ['ws-a', undefined]) {
        for (const reportGoalResult of [true, false]) {
          matrix.push({
            label: `${promptMode}/${runtime}/[${disabledToolGroups.join(',')}]/${workspaceSlug ?? 'no-ws'}/goal:${reportGoalResult}`,
            promptMode,
            runtime,
            disabledToolGroups,
            workspaceSlug,
            reportGoalResult,
          })
        }
      }
    }
  }
}

const SHARED_LOCALS = {
  sessionId: 'parity-session',
  channelId: 'parity-channel',
  modelId: 'parity-model',
  workspaceId: 'parity-workspace',
  presetOperationSource: 'user' as const,
  allowedPresetOperations: ['create'] as const,
  currentPresetReference: { presetId: 'parity-preset', presetScope: 'user-global' as const },
  userMessage: 'hello',
  userConfirmedPresetChange: false,
  pendingPresetChange: undefined,
  disabledTools: ['WebSearch'],
}

function buildOldAssembly(extraExternalServers: McpServerTable = {}) {
  const log: InjectionCall[] = []
  const deps = oldDeps(log)
  const slice = sliceBetween(orchestratorSource, SLICE_START, SLICE_END, 'builtin-mcp-injection')
  const wrapper = [
    'async function runOldBuiltinMcpAssembly(ctx) {',
    '  const {',
    '    promptMode, sessionId, workspaceSlug, presetPolicy, sdk, disabledToolGroups, disabledTools,',
    '    agentRuntime, input, channelId, modelId, workspaceId, presetOperationSource,',
    '    allowedPresetOperations, currentPresetReference, userMessage, userConfirmedPresetChange,',
    '    pendingPresetChange, self,',
    '  } = ctx',
    // `this.` 是旧方法里的编排器实例引用；切片编译后没有 this，统一绑定到 self 替身。
    slice.replace(/\bthis\./g, 'self.'),
    '  return mcpServers',
    '}',
  ].join('\n')

  const run = compileSlice<(ctx: Record<string, unknown>) => Promise<McpServerTable>>(
    wrapper,
    'runOldBuiltinMcpAssembly',
    deps as Record<string, unknown>,
  )

  const execute = async (item: MatrixCase): Promise<{ mcpServers: McpServerTable; calls: readonly InjectionCall[] }> => {
    const logStart = log.length
    const mcpServers = await run({
      promptMode: item.promptMode,
      sessionId: SHARED_LOCALS.sessionId,
      workspaceSlug: item.workspaceSlug,
      presetPolicy: { allowedMcpServerNames: undefined },
      sdk: {},
      disabledToolGroups: new Set(item.disabledToolGroups),
      disabledTools: SHARED_LOCALS.disabledTools,
      agentRuntime: item.runtime,
      input: {
        triggeredBy: 'user',
        reportGoalResult: item.reportGoalResult ? () => {} : undefined,
        goalIteration: 1,
      },
      channelId: SHARED_LOCALS.channelId,
      modelId: SHARED_LOCALS.modelId,
      workspaceId: SHARED_LOCALS.workspaceId,
      presetOperationSource: SHARED_LOCALS.presetOperationSource,
      allowedPresetOperations: SHARED_LOCALS.allowedPresetOperations,
      currentPresetReference: SHARED_LOCALS.currentPresetReference,
      userMessage: SHARED_LOCALS.userMessage,
      userConfirmedPresetChange: SHARED_LOCALS.userConfirmedPresetChange,
      pendingPresetChange: SHARED_LOCALS.pendingPresetChange,
      self: {
        // 旧链里 `buildMcpServers` 返回的就是切片里 `mcpServers` 的初值（外部 MCP 表）。
        buildMcpServers: () => ({ ...extraExternalServers }),
        activePresetPolicies: new Map<string, unknown>(),
      },
    })
    return { mcpServers, calls: log.slice(logStart) }
  }

  return { execute }
}

function buildNewPort() {
  const log: InjectionCall[] = []
  const port = createElectronBuiltinMcpInjectionPort({
    injectors: newInjectorOverrides(log),
    resolveMemoryArchivePath: workspaceSlug => `/parity/${workspaceSlug}/.context/memory-archive`,
  })
  return { port, log }
}

function newContext(item: MatrixCase): BuiltinMcpInjectionContext {
  return {
    sessionId: SHARED_LOCALS.sessionId,
    channelId: SHARED_LOCALS.channelId,
    modelId: SHARED_LOCALS.modelId,
    workspaceId: SHARED_LOCALS.workspaceId,
    ...(item.workspaceSlug !== undefined ? { workspaceSlug: item.workspaceSlug } : {}),
    runtime: item.runtime,
    triggeredBy: 'user',
    disabledTools: SHARED_LOCALS.disabledTools,
    preset: {
      source: SHARED_LOCALS.presetOperationSource,
      allowedOperations: [...SHARED_LOCALS.allowedPresetOperations],
      currentPresetReference: SHARED_LOCALS.currentPresetReference,
      userMessage: SHARED_LOCALS.userMessage,
    },
    ...(item.reportGoalResult ? { goal: { iteration: 1, report: () => {} } } : {}),
  }
}

function newPlanInput(item: MatrixCase): BuiltinMcpPlanInput {
  return {
    promptMode: item.promptMode,
    runtime: item.runtime,
    disabledToolGroups: item.disabledToolGroups,
    hasMemoryArchive: item.workspaceSlug !== undefined,
    hasGoalReport: item.reportGoalResult,
  }
}

describe('GAP-4 等价性：最终注入集合 / 顺序 / 上下文与旧链逐条一致', () => {
  test('切片标记有效（起点与终点都命中真实源码）', () => {
    const slice = sliceBetween(orchestratorSource, SLICE_START, SLICE_END, 'builtin-mcp-injection')
    expect(slice).toContain('await injectAutomationMcpServer(')
    expect(slice).toContain('await injectPlanningMcpServer(')
    expect(slice).not.toContain('injectVisualizationMcpServer')
  })

  test(`矩阵（${matrix.length} 组）两侧最终服务器集合与顺序一致`, async () => {
    const { execute } = buildOldAssembly()
    const mismatches: string[] = []

    for (const item of matrix) {
      const old = await execute(item)
      const oldInjected = Object.keys(old.mcpServers)
      const { port } = buildNewPort()
      const outcome = await runBuiltinMcpInjection(port, {
        context: newContext(item),
        mcpServers: {},
        sdk: {} as ClaudeSdkNamespace,
        planInput: newPlanInput(item),
      })
      if (JSON.stringify(oldInjected) !== JSON.stringify(outcome.injected)) {
        mismatches.push(`${item.label}: 旧=${JSON.stringify(oldInjected)} 新=${JSON.stringify(outcome.injected)}`)
      }
    }

    expect(mismatches).toEqual([])
  })

  test(`矩阵（${matrix.length} 组）两侧注入器收到的参数逐条一致`, async () => {
    const { execute } = buildOldAssembly()
    const mismatches: string[] = []

    for (const item of matrix) {
      const old = await execute(item)
      const { port, log } = buildNewPort()
      await runBuiltinMcpInjection(port, {
        context: newContext(item),
        mcpServers: {},
        sdk: {} as ClaudeSdkNamespace,
        planInput: newPlanInput(item),
      })
      const oldCalls = old.calls.filter(call => call.registered).map(call => ({ id: call.id, args: normalize(call.args) }))
      const newCalls = log.map(call => ({ id: call.id, args: normalize(call.args) }))
      if (JSON.stringify(oldCalls) !== JSON.stringify(newCalls)) {
        mismatches.push(`${item.label}:\n  旧=${JSON.stringify(oldCalls)}\n  新=${JSON.stringify(newCalls)}`)
      }
      // 旧链里唯一会「调用了但不注册」的是缺路径的 memory-archive；其余不应出现空调用。
      const noopIds = old.calls.filter(call => !call.registered).map(call => call.id)
      if (noopIds.some(id => id !== 'memory-archive')) {
        mismatches.push(`${item.label}: 旧链出现了非预期空调用 ${JSON.stringify(noopIds)}`)
      }
    }

    expect(mismatches).toEqual([])
  })

  test('内置注入不覆盖工作区用户 MCP，也不被其覆盖（与旧链的合并顺序一致）', async () => {
    const external: McpServerTable = { alpha: { type: 'stdio', command: 'run-alpha' } }
    const { execute } = buildOldAssembly(external)
    const item: MatrixCase = {
      label: 'standard/claude/all-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      reportGoalResult: true,
    }
    const old = await execute(item)
    const oldBuiltin = Object.keys(old.mcpServers).filter(name => name !== 'alpha')
    expect(oldBuiltin).toEqual([...BUILTIN_MCP_INJECTION_ORDER])

    const { port } = buildNewPort()
    const outcome = await runBuiltinMcpInjection(port, {
      context: newContext(item),
      mcpServers: { ...external },
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(item),
    })
    expect(outcome.injected as readonly string[]).toEqual(oldBuiltin)
  })

  test('buildBuiltinMcpInjectorArgs 是参数构造的唯一来源（端口 inject 复用它）', async () => {
    const item: MatrixCase = {
      label: 'standard/claude/all-on',
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      workspaceSlug: 'ws-a',
      reportGoalResult: true,
    }
    const context = newContext(item)
    const request = {
      context,
      mcpServers: {},
      sdk: {} as ClaudeSdkNamespace,
      planInput: newPlanInput(item),
    }
    const expected = await buildBuiltinMcpInjectorArgs('automation', request, workspaceSlug => `/parity/${workspaceSlug}`)
    expect(normalize(expected)).toEqual([
      { sessionId: 'parity-session', channelId: 'parity-channel', modelId: 'parity-model', workspaceId: 'parity-workspace', triggeredBy: 'user' },
      ['WebSearch'],
    ])
  })

  test('规划与旧链同序：automation → memory-archive → collaboration → task-graph → goal → agent-presets → planning', () => {
    expect(planBuiltinMcpServers({
      promptMode: 'standard',
      runtime: 'claude',
      disabledToolGroups: [],
      hasMemoryArchive: true,
      hasGoalReport: true,
    }).map(entry => entry.id)).toEqual([
      'automation',
      'memory-archive',
      'collaboration',
      'task-graph',
      'goal',
      'agent-presets',
      'planning',
    ] as const)
  })
})
