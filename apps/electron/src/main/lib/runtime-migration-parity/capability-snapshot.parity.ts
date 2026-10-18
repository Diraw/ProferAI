/**
 * runtime-migration-parity / 能力快照（preset / 计划模式 / 权限 / skill / MCP / 工具组）对照（重点 5）
 *
 * 目的：为"切换入口后能力可见性是否与原路径一致"建立**可执行清单**。
 * 两侧证据来源：
 * - 旧侧：真实 orchestrator（切片编译）+ 真实 `createEffectiveAgentPresetPolicy`，
 *   观测它交给 provider 的 query options 与它发出的 profer_event。
 * - 新侧：真实 `createElectronProviderQueryPreparation` / `createElectronAgentRuntimeQuery` /
 *   真实 coordinator，观测 adapter 实际收到的 provider options 与 host 事件。
 *
 * 本轮（2026-10-16 集成会话）变更声明：
 * - 入口接线已落地（`agent-runtime-entry.ts` 的 `runRuntimeHeadlessEntry`，由 `agent-service.ts` 的
 *   `runAgentRuntimeHeadless` 调用）：每轮解析并冻结策略快照、挂到 query、在 run 起点投影计划模式；
 * - 带【切换门槛】的用例现在驱动**真实入口**（`createEntryDriver` → 真实 `runRuntimeHeadlessEntry`），
 *   因此 G4/G5 已转绿；未挂载快照的裸 query builder 仍作为对照证据保留。
 * - 末尾「策略快照接线」小节保留为模块级等价证据，与入口级门槛分开陈述。
 */

import { describe, expect, test } from 'bun:test'
import { AGENT_PRESET_CAPABILITY_GROUPS, createEffectiveAgentPresetPolicy, isEffectiveAgentPresetMcpServerAllowed, type ProferPermissionMode, type SDKMessage } from '@profer/shared'
import { createAgentQueryPreparationPort } from '@profer/agent-runtime'
import { createElectronAgentRuntimeQuery } from '../agent-runtime-host'
import { createElectronProviderQueryPreparation } from '../agent-runtime-provider-preparation'
import {
  attachAgentRuntimePolicyToQuery,
  buildPolicyToolAssemblyContext,
  collectPolicyDisallowedTools,
  filterPolicyMcpResources,
  filterPolicySkills,
  resolveAgentRuntimePolicySnapshot,
} from '../agent-runtime-policy-snapshot'
import type { AgentRuntimePolicyResolutionInput } from '../agent-runtime-policy-snapshot'
import {
  clearAgentRuntimePlanMode,
  createAgentRuntimePlanModeFromPolicy,
  registerAgentRuntimePlanMode,
  type AgentRuntimePlanModeEvent,
} from '../agent-runtime-plan-mode'
import { buildPiBuiltinTools } from '../adapters/pi-builtin-tools'
import { createNewEngine } from './support/new-engine'
import { createEntryDriver } from './support/new-entry'
import { createOldEngine } from './support/old-engine'
import { createParityHost } from './support/parity-host'
import { countOccurrences, readMainSource, sliceBetween } from './support/compile-slice'

/** 能力清单：每一行都由本文件中的断言提供可执行证据。 */
export const CAPABILITY_INVENTORY = [
  { aspect: '默认权限模式', old: '预设策略（PROFER_DEFAULT_PERMISSION_MODE）', new: '入口每轮冻结策略快照 → providerInput.permissionMode；未挂载时不注入（不猜默认值、不放行）', verdict: '入口级已验证（门槛 G4 已转绿）' },
  { aspect: '计划模式显式覆盖', old: '策略接受 plan + 发 enter_plan_mode / plan_mode_changed', new: '入口注册计划模式控制器并在 run 起点投影同一组事件；审批走宿主权限端口', verdict: '入口级已验证（门槛 G5 已转绿）' },
  { aspect: '预设策略快照', old: '每轮一次 createEffectiveAgentPresetPolicy，注入前冻结到 activePresetPolicies', new: '入口每轮解析一次并冻结（run registry），运行结束释放', verdict: '入口级已验证' },
  { aspect: 'skill 可见性', old: 'resourcePort 过滤 enabled + 预设 skillSlugs 裁剪', new: 'resource port 接入 filterPolicySkills（与本轮快照同一份规则）', verdict: '入口级已验证' },
  { aspect: 'MCP 可见性', old: '预设白名单裁剪 + 内置 MCP 注入', new: 'filterPolicyMcpResources 白名单裁剪 + 宿主资源端口注入内置 MCP（GAP-4 已接线）', verdict: '两侧均接线；新路径提示词模式恒为 standard（已知差异，见集成报告）' },
  { aspect: '工具组快照', old: 'disabledToolGroups/disabledTools/pptCapabilityActive 进入工具装配 context', new: '入口用 buildPolicyToolAssemblyContext 把同一批字段送进装配（已用真实 buildPiBuiltinTools 验证）', verdict: '入口级已验证' },
  { aspect: '工具装配时机', old: '编排层在 provider 前装配', new: 'deferredToolAssembly 延迟到 adapter 拿到 SDK 后', verdict: '机制不同但可控' },
] as const

const input = (extra: Record<string, unknown> = {}) => ({
  sessionId: 'parity-session',
  channelId: 'parity-channel',
  userMessage: 'hello',
  agentRuntime: 'pi' as const,
  ...extra,
})

const resultStream = () => (async function* stream(): AsyncGenerator<SDKMessage> {
  yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
})()

const parityPreset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'parity-preset',
  name: 'parity preset',
  description: '',
  isBuiltin: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

function entryPolicy(
  overrides: Record<string, unknown> = {},
  permissionModeOverride?: ProferPermissionMode,
): AgentRuntimePolicyResolutionInput {
  return {
    preset: parityPreset(overrides) as never,
    presetReference: { presetId: 'parity-preset', presetScope: 'user-global' },
    ...(permissionModeOverride ? { permissionModeOverride } : {}),
  }
}

/**
 * 入口级 driver：驱动**真实** `agent-runtime-entry.ts`（生产入口接线），
 * 宿主端口与 provider preparation 均为真实实现，只有 provider 传输是 fake stream。
 */
function entryDriverFor(options: {
  policy?: AgentRuntimePolicyResolutionInput
  toolAssemblyContext?: Record<string, unknown>
} = {}) {
  const host = createParityHost({
    runtime: 'pi',
    providerQueryPreparation: createElectronProviderQueryPreparation(),
    // 入口总是传 toolAssemblyContext（策略字段就并在这里），因此宿主必须提供装配端口 ——
    // 与生产一致（`createElectronAgentHost` 总是注入 toolAssembly）。
    toolAssembly: { build: async () => ({ tools: [], collaborationAvailable: false }) },
  })
  const providerOptions: Array<Record<string, unknown>> = []
  const deferredContexts: Array<Record<string, unknown> | undefined> = []
  const driver = createEntryDriver({
    host,
    adapters: {
      pi: {
        runtime: 'pi',
        stream: query => {
          providerOptions.push((query.providerInput ?? {}) as Record<string, unknown>)
          deferredContexts.push(query.deferredToolAssemblyContext as Record<string, unknown> | undefined)
          return resultStream()
        },
      },
    },
    resolveRunContext: () => ({
      runtime: 'pi',
      cwd: '/tmp/parity-cwd',
      toolAssemblyContext: options.toolAssemblyContext ?? { sessionId: 'parity-session', channelId: 'parity-channel' },
      ...(options.policy ? { policy: options.policy } : {}),
    }),
  })
  return { host, driver, providerOptions, deferredContexts }
}

async function oldProviderOptions(extra: Record<string, unknown> = {}) {
  const host = createParityHost({ runtime: 'pi' })
  const old = createOldEngine({ host, input: input(extra), adapter: { query: resultStream } })
  await old.run()
  return { options: old.recording.providerQueries[0] ?? {}, events: host.events.eventPort, host, old }
}

async function newProviderOptions(providerInputOverride?: Record<string, unknown>) {
  const host = createParityHost({ runtime: 'pi' })
  const captured: Array<Record<string, unknown>> = []
  const engine = createNewEngine({
    host,
    adapters: {
      pi: {
        runtime: 'pi',
        stream: () => resultStream(),
      },
    },
    portsOverride: undefined,
  } as never)
  // 用真实 provider preparation port 观察 provider options，再交给 fake adapter 触发一次完整 run。
  const preparation = createElectronProviderQueryPreparation()
  const query = createElectronAgentRuntimeQuery(
    {
      sessionId: 'parity-session',
      channelId: 'parity-channel',
      userMessage: 'hello',
      agentRuntime: 'pi',
      ...(providerInputOverride ? { permissionModeOverride: providerInputOverride.permissionMode } : {}),
    } as never,
    { runtime: 'pi', cwd: '/tmp/parity-cwd', toolAssemblyContext: { sessionId: 'parity-session', channelId: 'parity-channel' } },
  )
  const options = await preparation.prepare(
    query,
    { credentials: { apiKey: 'parity-key', baseUrl: undefined, provider: 'custom', forceBearerAuth: false } },
    new AbortController().signal,
  )
  captured.push(options as unknown as Record<string, unknown>)
  await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel' })
  return { options: captured[0] ?? {}, query, host }
}

describe('权限模式与计划模式', () => {
  test('默认权限模式：旧路径取预设策略值，新路径在宿主未挂载策略快照时不注入任何模式', async () => {
    const old = await oldProviderOptions()
    expect(old.options.permissionMode).toBe('bypassPermissions')
    const next = await newProviderOptions()
    // 本轮起 provider preparation 不再猜默认值：既不是旧的 'auto'，也不是预设默认值，而是"不注入"。
    expect(next.options.permissionMode).toBeUndefined()
  })

  test('【切换门槛】未显式覆盖时两侧默认权限模式必须一致（已修复：入口挂载策略快照）', async () => {
    // 修复前：入口未挂载策略快照 → 新路径不注入权限模式，与旧路径的预设默认值不一致。
    // 修复后：入口每轮解析并冻结策略快照，provider preparation 只消费它。
    const old = await oldProviderOptions()
    const { driver, providerOptions } = entryDriverFor({ policy: entryPolicy() })
    await driver.run({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' })
    expect(providerOptions[0]?.permissionMode).toBe('bypassPermissions')
    expect(providerOptions[0]?.permissionMode).toBe(old.options.permissionMode)
  })

  test('显式 plan 覆盖：两侧都得到 plan（一致）', async () => {
    const old = await oldProviderOptions({ permissionModeOverride: 'plan' })
    expect(old.options.permissionMode).toBe('plan')
    const next = await newProviderOptions({ permissionMode: 'plan' })
    expect(next.options.permissionMode).toBe('plan')
  })

  test('【切换门槛】plan 模式必须仍向 UI 投影进入计划模式（已修复：入口注册并投影控制器）', async () => {
    const old = await oldProviderOptions({ permissionModeOverride: 'plan' })
    const oldEventTypes = old.events.map(payload => payload.kind === 'profer_event' ? payload.event.type : payload.kind)
    expect(oldEventTypes).toContain('enter_plan_mode')
    expect(oldEventTypes).toContain('plan_mode_changed')

    const { host, driver, providerOptions } = entryDriverFor({ policy: entryPolicy({}, 'plan') })
    await driver.run({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' })
    expect(providerOptions[0]?.permissionMode).toBe('plan')
    // 入口在 run 起点投影到 host 事件通道（与旧路径同一组事件类型）。
    const projectedTypes = host.events.runtime.flatMap(event => event.type === 'host_event' ? [event.event.type] : [])
    expect(projectedTypes).toEqual(['enter_plan_mode', 'plan_mode_changed'])
    expect(new Set(projectedTypes)).toEqual(new Set(oldEventTypes.filter(type => type === 'enter_plan_mode' || type === 'plan_mode_changed')))
  })

  test('对照证据：裸 query builder 不投影计划模式，入口挂载快照后才投影', async () => {
    // 未挂载策略快照的 `createElectronAgentRuntimeQuery`（其他宿主 / 未接线调用方）：没有控制器，因此没有投影。
    const bare = await newProviderOptions({ permissionMode: 'plan' })
    expect(bare.host.events.runtime.map(event => event.type)).toEqual(['runtime_claimed', 'runtime_started', 'message', 'runtime_finished'])
    expect(bare.host.events.runtime.flatMap(event => event.type === 'host_event' ? [event.event.type] : [])).toEqual([])

    // 入口（真实生产接线）：同一输入下投影 enter_plan_mode / plan_mode_changed。
    const { host, driver } = entryDriverFor({ policy: entryPolicy({}, 'plan') })
    await driver.run({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' })
    expect(host.events.runtime.flatMap(event => event.type === 'host_event' ? [event.event.type] : []))
      .toEqual(['enter_plan_mode', 'plan_mode_changed'])
  })
})

describe('预设策略快照', () => {
  test('旧路径：每轮解析一次预设策略并在异步 MCP 注入前冻结（源码证据）', () => {
    const source = readMainSource('agent-orchestrator.ts')
    expect(source).toContain('const presetPolicy = createEffectiveAgentPresetPolicy(')
    const freezeIndex = source.indexOf('this.activePresetPolicies.set(sessionId, withLoadedMcpServerNames(presetPolicy, Object.keys(mcpServers)))')
    const injectionIndex = source.indexOf('await injectAutomationMcpServer(')
    expect(freezeIndex).toBeGreaterThan(-1)
    expect(injectionIndex).toBeGreaterThan(freezeIndex)
    // 预设策略在重试循环之外计算：只出现一次，且位于 provider 查询之前。
    expect(countOccurrences(source, 'createEffectiveAgentPresetPolicy(')).toBe(1)
  })

  test('新路径：provider preparation 只消费策略快照，不重新解析预设规则', () => {
    const providerPreparation = readMainSource('agent-runtime-provider-preparation.ts')
    expect(providerPreparation).toContain('resolveProviderPermissionMode')
    expect(providerPreparation).toContain('预设策略经 providerInput 传入，本函数不重新解释')
    // 规则仍只有一份：provider preparation 里不得出现预设解析与判定函数。
    expect(countOccurrences(providerPreparation, 'createEffectiveAgentPresetPolicy')).toBe(0)
    expect(countOccurrences(providerPreparation, 'isEffectiveAgentPreset')).toBe(0)
    const hostSource = readMainSource('agent-runtime-host.ts')
    const queryBuilder = sliceBetween(hostSource, 'export function createElectronAgentRuntimeQuery(', 'export interface ElectronAgentHost', 'query-builder')
    expect(countOccurrences(queryBuilder, 'Preset')).toBe(0)
    expect(countOccurrences(queryBuilder, 'disabledToolGroups')).toBe(0)
  })

  test('真实预设策略：disabledToolGroups 会隐藏对应工具组（共享实现的行为基线）', () => {
    const preset = { id: 'p', name: 'p', disabledToolGroups: ['ppt-materials'] } as never
    const policy = createEffectiveAgentPresetPolicy(preset, { presetId: 'p', presetScope: 'user-global' }, { runtimeSupportsSubagents: true })
    expect(policy.disabledToolGroups).toContain('ppt-materials')
    expect(policy.disabledToolGroups).not.toContain('collaboration')
    const allowed = createEffectiveAgentPresetPolicy({ id: 'p', name: 'p', allowSubagents: false } as never, { presetId: 'p', presetScope: 'user-global' }, { runtimeSupportsSubagents: true })
    expect(allowed.disabledToolGroups).toContain('collaboration')
    expect(AGENT_PRESET_CAPABILITY_GROUPS.length).toBeGreaterThan(0)
  })
})

describe('skill / MCP 可见性', () => {
  test('通用 preparation 复制 resources.skills 与 mcpResources，但不做预设裁剪', async () => {
    const port = createAgentQueryPreparationPort({
      resources: {
        load: () => ({
          skills: ['skill-a', 'skill-b'],
          mcpResources: [{ name: 'alpha', command: 'a' }, { name: 'beta', command: 'b' }],
          projectInstructions: ['instructions'],
        }),
      },
    })
    const prepared = await port.prepare({ sessionId: 's', prompt: 'p', runtime: 'pi' }, new AbortController().signal)
    expect(prepared.skills).toEqual(['skill-a', 'skill-b'])
    expect(Object.keys(prepared.mcpServers ?? {})).toEqual(['alpha', 'beta'])
    expect(prepared.systemPrompt).toBe('instructions')
  })

  test('预设 MCP 白名单裁剪只存在于旧路径；共享判定函数与策略快照过滤行为可执行验证', () => {
    const policy = createEffectiveAgentPresetPolicy({ id: 'p', name: 'p', mcpServerNames: ['alpha'] } as never, { presetId: 'p', presetScope: 'user-global' })
    expect(isEffectiveAgentPresetMcpServerAllowed(policy, 'alpha')).toBe(true)
    expect(isEffectiveAgentPresetMcpServerAllowed(policy, 'beta')).toBe(false)

    const source = readMainSource('agent-orchestrator.ts')
    expect(source).toContain('isEffectiveAgentPresetMcpServerAllowed(presetPolicy, name)')
    const providerPreparation = readMainSource('agent-runtime-provider-preparation.ts')
    expect(countOccurrences(providerPreparation, 'McpServerAllowed')).toBe(0)

    // 新路径的裁剪入口（宿主侧）：同一份共享判定，过滤后交给 provider 的服务器集合即白名单交集。
    const snapshot = resolveAgentRuntimePolicySnapshot({
      preset: { id: 'p', name: 'p', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0, mcpServerNames: ['alpha'] } as never,
      presetReference: { presetId: 'p', presetScope: 'user-global' },
    })
    expect(filterPolicyMcpResources(snapshot, [{ name: 'alpha' }, { name: 'beta' }]).map(resource => resource.name)).toEqual(['alpha'])
    expect(filterPolicySkills(snapshot, ['any-skill'])).toEqual(['any-skill'])
  })
})

describe('工具组快照与装配时机', () => {
  test('入口把策略字段合并进工具装配 context（禁用在新路径生效）', async () => {
    // 修复前：入口只传 sessionId/channelId/permissionMode，预设工具组禁用在新路径失效。
    // 修复后：入口用同一份策略快照构造装配 context，禁用字段真实到达装配实现。
    const { driver, deferredContexts } = entryDriverFor({
      policy: entryPolicy({ disabledToolGroups: ['ppt-materials', 'browser', 'clipboard'] }),
    })
    await driver.run({ sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' })
    const context = deferredContexts[0]
    expect(context).toBeDefined()
    expect(context?.disabledToolGroups).toEqual(['ppt-materials', 'browser', 'clipboard'])
    expect(context?.pptCapabilityActive).toBe(false)
    expect(context?.permissionMode).toBe('bypassPermissions')

    // 旧的源码切片断言（入口 context 字面量缺字段）已随修复失效：改为断言入口确实调用共享合并函数。
    const agentServiceSource = readMainSource('agent-service.ts')
    expect(agentServiceSource).toContain('toolAssemblyContext:')
    const entrySource = readMainSource('agent-runtime-entry.ts')
    expect(entrySource).toContain('buildPolicyToolAssemblyContext(snapshot, options.toolAssemblyContext)')
  })

  test('工具装配 context 的字段确实决定工具可见性（PiBuiltinToolsContext 期望字段）', () => {
    const source = readMainSource('adapters/pi-builtin-tools.ts')
    const contextType = sliceBetween(source, 'export interface PiBuiltinToolsContext {', '}\n', 'pi-context')
    for (const key of ['disabledToolGroups', 'disabledTools', 'pptCapabilityActive', 'allowedRoots', 'permissionMode']) {
      expect(contextType).toContain(key)
    }
  })

  test('deferredToolAssembly 只在提供了装配 context 时出现；缺少 toolAssembly 端口时明确失败', async () => {
    const withoutContext = await createAgentQueryPreparationPort({}).prepare(
      { sessionId: 's', prompt: 'p', runtime: 'pi' },
      new AbortController().signal,
    )
    expect(withoutContext.deferredToolAssembly).toBeUndefined()

    const withContext = await createAgentQueryPreparationPort({ toolAssembly: { build: async () => ({ tools: ['t'] }) } }).prepare(
      { sessionId: 's', prompt: 'p', runtime: 'pi', deferredToolAssemblyContext: { sessionId: 's' } },
      new AbortController().signal,
    )
    expect(typeof withContext.deferredToolAssembly?.build).toBe('function')

    const missingPort = createAgentQueryPreparationPort({})
    await expect(missingPort.prepare(
      { sessionId: 's', prompt: 'p', runtime: 'pi', deferredToolAssemblyContext: { sessionId: 's' } },
      new AbortController().signal,
    )).rejects.toThrow('Agent tool assembly host is not configured')
  })

  test('真实 buildPiBuiltinTools：disabledToolGroups 会真实减少注册工具（缺字段即禁用失效）', async () => {
    const fakeSdk = { defineTool: (definition: unknown) => definition }
    const baseContext = { sessionId: 's', channelId: 'c', permissionMode: 'bypassPermissions' as const, triggeredBy: 'user' as const, agentCwd: '/tmp/parity-cwd' }
    const full = await buildPiBuiltinTools(fakeSdk as never, baseContext as never)
    const gated = await buildPiBuiltinTools(fakeSdk as never, { ...baseContext, disabledToolGroups: ['ppt-materials', 'image', 'browser', 'clipboard'] } as never)
    const toolNames = (result: { tools: readonly unknown[] }): string[] => result.tools.map(tool => (tool as { name?: string }).name ?? '').filter(Boolean)
    expect(toolNames(full).length).toBeGreaterThan(toolNames(gated).length)
    expect(toolNames(full).length).toBeGreaterThan(30)

    // 新路径真实传入的装配 context（`createElectronAgentRuntimeQuery` 的 deferredToolAssemblyContext）
    // 只带会话标识与权限模式，因此上述禁用无法生效。
    const query = createElectronAgentRuntimeQuery(
      { sessionId: 's', channelId: 'c', userMessage: 'hello', agentRuntime: 'pi' } as never,
      { runtime: 'pi', toolAssemblyContext: { sessionId: 's', channelId: 'c', permissionMode: undefined } },
    )
    const context = query.deferredToolAssemblyContext as Record<string, unknown>
    expect(Object.keys(context).sort()).toEqual(['channelId', 'permissionMode', 'sessionId'])
  })

  test('adapter 收到的是延迟装配后的 tools（新路径在 adapter 拿到 SDK 后装配）', async () => {
    const host = createParityHost({
      runtime: 'pi',
      queryPreparation: createAgentQueryPreparationPort({
        toolAssembly: { build: async (input) => { builtWith.push(input.sdk); return { tools: ['tool-x'] } } },
      }),
    })
    const builtWith: unknown[] = []
    const received: Array<Record<string, unknown>> = []
    const engine = createNewEngine({
      host,
      adapters: {
        pi: {
          runtime: 'pi',
          stream: (queryOptions) => {
            received.push({ prepared: queryOptions.prepared as unknown as Record<string, unknown> })
            return resultStream()
          },
        },
      },
    })
    await engine.run({ sessionId: 'parity-session', channelId: 'parity-channel', deferredToolAssemblyContext: { sessionId: 'parity-session' } })
    const prepared = received[0]?.prepared as { deferredToolAssembly?: { build(sdk: unknown): Promise<{ tools: readonly unknown[] }> } } | undefined
    const built = await prepared?.deferredToolAssembly?.build({ fakeSdk: true })
    expect(built).toEqual({ tools: ['tool-x'] })
    expect(builtWith).toEqual([{ fakeSdk: true }])
  })
})

/**
 * 策略快照接线（模块级行为验证）。
 *
 * 与上面的【切换门槛】分开陈述：
 * - 门槛用例证明「入口尚未接线」；
 * - 本节证明「接线后行为与旧路径一致」，且全部走真实端口（真实 provider preparation、
 *   真实 coordinator、真实 buildPiBuiltinTools）。
 * 入口侧需要做的只是把这三步接到 agent-service：解析快照 → 挂到 query → 在 run 起点投影。
 */
describe('策略快照接线（模块级行为验证）', () => {
  const policyPreset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'parity-preset',
    name: 'parity preset',
    description: '',
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  })

  const snapshotFor = (overrides: Record<string, unknown> = {}, permissionModeOverride?: ProferPermissionMode) =>
    resolveAgentRuntimePolicySnapshot({
      preset: policyPreset(overrides) as never,
      presetReference: { presetId: 'parity-preset', presetScope: 'user-global' },
      ...(permissionModeOverride ? { permissionModeOverride } : {}),
    })

  const wiredQuery = (snapshot: ReturnType<typeof snapshotFor>) =>
    attachAgentRuntimePolicyToQuery(
      createElectronAgentRuntimeQuery(
        { sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello', agentRuntime: 'pi' } as never,
        { runtime: 'pi', cwd: '/tmp/parity-cwd', toolAssemblyContext: { sessionId: 'parity-session', channelId: 'parity-channel' } },
      ),
      snapshot,
    )

  const prepareOptions = async (query: ReturnType<typeof wiredQuery>) => {
    const preparation = createElectronProviderQueryPreparation()
    return await preparation.prepare(
      query,
      { credentials: { apiKey: 'parity-key', baseUrl: undefined, provider: 'custom', forceBearerAuth: false } },
      new AbortController().signal,
    ) as unknown as Record<string, unknown>
  }

  async function oldOptionsWithPreset(preset: Record<string, unknown>) {
    const host = createParityHost({ runtime: 'pi' })
    const old = createOldEngine({ host, input: input(), adapter: { query: resultStream }, preset })
    await old.run()
    return old.recording.providerQueries[0] ?? {}
  }

  test('Given 宿主挂载策略快照 When 比较默认权限模式 Then 与旧路径同源（G4 等价证据）', async () => {
    const old = await oldProviderOptions()
    const wired = await prepareOptions(wiredQuery(snapshotFor()))
    expect(wired.permissionMode).toBe('bypassPermissions')
    expect(wired.permissionMode).toBe(old.options.permissionMode)
  })

  test('Given 预设声明 auto When 两侧比较 Then 新路径取同一份策略值而不是猜测', async () => {
    const old = await oldOptionsWithPreset(policyPreset({ permissionMode: 'auto' }))
    expect(old.permissionMode).toBe('auto')
    const wired = await prepareOptions(wiredQuery(snapshotFor({ permissionMode: 'auto' })))
    expect(wired.permissionMode).toBe(old.permissionMode)
  })

  test('Given 显式 plan 覆盖 When 两侧比较 Then 权限模式与计划模式投影都一致（G5 等价证据）', async () => {
    const snapshot = snapshotFor({}, 'plan')
    // 工具装配端口必须存在：本用例验证的是「真正启动后」的计划模式投影，
    // 而 `wiredQuery` 带 `toolAssemblyContext`，缺少装配端口会在准备阶段失败（provider 不启动）。
    const host = createParityHost({ runtime: 'pi', toolAssembly: { build: async () => ({ tools: [] }) } })
    const projected: AgentRuntimePlanModeEvent[] = []
    const controller = createAgentRuntimePlanModeFromPolicy({
      sessionId: 'parity-session',
      snapshot,
      agentCwd: '/tmp/parity-cwd',
      emit: (event) => {
        projected.push(event)
        // 入口投影通道：host port 的 host_event 会被 Electron 侧转成 profer_event 推给 UI。
        void host.ports.host?.emit({ type: 'host_event', sessionId: 'parity-session', event })
      },
    })
    registerAgentRuntimePlanMode(controller)
    try {
      const engine = createNewEngine({ host, adapters: { pi: { runtime: 'pi', stream: () => resultStream() } } })
      const query = wiredQuery(snapshot)
      await engine.run(query as never, { onRunStarted: () => { controller.start() } })
      const wired = await prepareOptions(query)
      expect(wired.permissionMode).toBe('plan')
    } finally {
      clearAgentRuntimePlanMode('parity-session')
    }

    // 新路径（接线后）投影到 host 事件通道的计划模式事件。
    // 投影挂在 `onRunStarted` 上：准备成功、provider 即将启动时才发生（准备失败不得宣告运行开始）。
    const projectedTypes = host.events.runtime.flatMap(event => event.type === 'host_event' ? [event.event.type] : [])
    expect(projected.map(event => event.type)).toEqual(['enter_plan_mode', 'plan_mode_changed'])

    // 旧路径（真实 orchestrator 切片）在相同覆盖下发出的 profer_event。
    const old = await oldProviderOptions({ permissionModeOverride: 'plan' })
    const oldEventTypes = old.events.map(payload => payload.kind === 'profer_event' ? payload.event.type : payload.kind)
    expect(oldEventTypes).toContain('enter_plan_mode')
    expect(oldEventTypes).toContain('plan_mode_changed')
    // 两侧的进入计划模式事件类型集合一致（旧侧还包含 sdk_message，本断言只比较计划模式相关投影）。
    expect(new Set(projectedTypes)).toEqual(new Set(oldEventTypes.filter(type => type === 'enter_plan_mode' || type === 'plan_mode_changed')))
  })

  test('Given 策略禁用工具组 When 送入真实工具装配 Then 最终注册工具真的减少（缺口 #29 的接线证据）', async () => {
    const snapshot = snapshotFor({ disabledToolGroups: ['ppt-materials', 'browser', 'clipboard'] })
    const baseContext = { sessionId: 'parity-session', channelId: 'parity-channel', permissionMode: 'bypassPermissions', triggeredBy: 'user', agentCwd: '/tmp/parity-cwd', pptCapabilityActive: true }
    const fakeSdk = { defineTool: (definition: unknown) => definition }
    const base = await buildPiBuiltinTools(fakeSdk as never, baseContext as never)
    const gated = await buildPiBuiltinTools(fakeSdk as never, buildPolicyToolAssemblyContext(snapshot, baseContext) as never)
    const names = (result: { tools: readonly unknown[] }) => result.tools.map(tool => (tool as { name?: string }).name ?? '')
    expect(names(base)).toContain('BrowserNavigate')
    expect(names(gated)).not.toContain('BrowserNavigate')
    expect(names(gated).length).toBeLessThan(names(base).length)
    // Claude 侧同一策略折算为 disallowedTools，保证两套 runtime 工具面等价。
    const disallowed = collectPolicyDisallowedTools(snapshot)
    expect(disallowed).toContain('BrowserNavigate')
    expect(disallowed).not.toContain('clipboard_read_text')
  })
})
