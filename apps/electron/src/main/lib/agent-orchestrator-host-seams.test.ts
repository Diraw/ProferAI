import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AgentRuntimeQuery, AgentRuntimePreparedContext, AgentRuntimePorts, PermissionPort, PreviewPort, SessionPort, ToolAssemblyPort } from '@profer/agent-runtime'
import { normalizeAgentRuntime } from '@profer/shared'
import type { AgentSessionMeta, AgentStreamPayload, SDKMessage } from '@profer/shared'
import { isPartialSDKMessage, tryReserveQueuedMessage, shouldPreInterruptQueuedMessage } from './agent-orchestrator-p0-guards'
// GAP-D1：标题来源收集与命名窗口的编排已移到共享模块（旧链与新 runtime 链共用），
// 切片编译必须注入真实实现，否则 `regenerateTitle` 会在求值处抛 ReferenceError。
import { collectSessionTitleSources, runSessionTitleNaming } from './agent-session-title-naming'
import { AgentFilePreviewSessionManager } from './agent-file-preview-session'
import { createAgentQueryPreparationPort, createAgentRunOwnershipRegistry, createAgentRunOwnershipView, createAgentRunRejectionError } from '@profer/agent-runtime'
import type { AgentRunOwnershipRegistry, AgentRunOwnershipView } from '@profer/agent-runtime'
import { createElectronPermissionPort } from './agent-runtime-permission-port'

// 复用 Goal bridge 的真实源码编译方式，只执行构造和端口 seam；不加载宿主单例或模型 SDK。
const source = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf8')
const classSource = source.slice(source.indexOf('export class AgentOrchestrator'))
const compiled = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(classSource.replace('export class', 'class'))
interface SeamFixture {
  sessionPort: SessionPort
  activeSessions: AgentRunOwnershipView
  ownership: AgentRunOwnershipRegistry
  activeSkillRoutings: Map<string, Promise<unknown>>
  activeRuntimeRegistrations: Map<string, Promise<boolean>>
  generateTitle(input: unknown): Promise<string>
  regenerateTitle(sessionId: string, channelId: string, modelId: string): Promise<string | null>
  persistSDKMessages(sessionId: string, messages: SDKMessage[], durationMs?: number): void
  persistSkillRoutingNotice(sessionId: string, routed: unknown): void
  queueMessage(sessionId: string, text: string, rawText?: string, priority?: string, uuid?: string): Promise<string>
  permissionPort: PermissionPort
  previewPort: PreviewPort
  queryPreparations: Map<string, AbortController>
  stoppedBySessions: Set<string>
  prepareProviderQuery(input: AgentRuntimeQuery): Promise<AgentRuntimePreparedContext>
  queryPreparedProvider(input: AgentRuntimeQuery, options: object): Promise<AsyncIterable<SDKMessage>>
  buildPiBuiltinTools(sdk: unknown, context: unknown): Promise<{ tools: readonly unknown[]; collaborationAvailable?: boolean }>
}
function fixture(ports: AgentRuntimePorts = {}, adapter: object = {}) {
  const manager = new AgentFilePreviewSessionManager(100)
  const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
  const builtinResult = { tools: [{ name: 'legacy-tool' }], collaborationAvailable: false }
  let legacyBuilds = 0
  const dependencies = {
    getAgentSessionMeta() {}, appendSDKMessages() {}, updateAgentSessionMeta() {},
    lockAgentSessionRuntime() {},
    getAgentSessionSDKMessages: () => [], getAgentSessionMessages: () => [],
    registerCollaborationEventBus() {}, setHeadlessAgentRunner() {}, setAgentStopper() {},
    agentFilePreviewSessionManager: manager,
    createElectronPermissionPort,
    createAgentQueryPreparationPort,
    createAgentRunOwnershipRegistry,
    createAgentRunOwnershipView,
    createAgentRunRejectionError,
    console: { log() {}, warn() {}, error() {} },
    collectSessionTitleSources, runSessionTitleNaming, isPartialSDKMessage,
    normalizeAgentRuntime, tryReserveQueuedMessage, shouldPreInterruptQueuedMessage,
    getAgentWorkspace: () => undefined,
    buildReferencedSessionsPrompt: () => '',
    selectAgentPromptMode: () => 'standard',
    browserController: { getUserContext: () => undefined },
    routeSkillsForTask: () => ({ selected: [], hints: [], diagnostics: [], prompt: '' }),
    buildSkillRoutingNotice: () => 'fixture skill notice',
    buildPiBuiltinTools: async () => { legacyBuilds++; return builtinResult },
  }
  const Constructor = new Function(...Object.keys(dependencies), `${compiled}\nreturn AgentOrchestrator`)(...Object.values(dependencies)) as new (
    adapter: object,
    eventBus: { emit(sessionId: string, payload: AgentStreamPayload): void },
    ports: AgentRuntimePorts,
    ownership: AgentRunOwnershipRegistry,
  ) => SeamFixture
  // 执行权归共享登记表：测试用同一实例模拟「会话已在运行」。
  const ownership = createAgentRunOwnershipRegistry()
  const instance = new Constructor(adapter, { emit: (sessionId, payload) => events.push({ sessionId, payload }) }, ports, ownership)
  return { instance, manager, events, builtinResult, legacyBuilds: () => legacyBuilds, ownership }
}

const identity = { sessionId: 'session-seam', filePath: '/safe/deck.pptx', revision: 'sha256:seam' }
const open = { ...identity, type: 'preview_requested' as const, requestId: 'seam-open', readOnly: true }
const inspect = { ...identity, requestId: 'seam-inspect', scope: 'page' as const, page: 1 }

describe('AgentOrchestrator host seams', () => {
  test('Given injected session storage When persisting assistant output Then partial frames and plain SDK user text are filtered before the synchronous write', () => {
    const persisted: SDKMessage[] = []
    const sessions: SessionPort = {
      getMeta: () => undefined,
      updateMeta() {},
      appendMessages: (_id, messages) => { persisted.push(...messages) },
    }
    const h = fixture({ sessions })
    const complete = { type: 'assistant', uuid: 'complete', message: { content: [{ type: 'text', text: 'complete' }] } } as SDKMessage
    const partial = { ...complete, uuid: 'partial', _partial: true } as SDKMessage
    const plainUser = { type: 'user', message: { content: [{ type: 'text', text: 'SDK internal' }] }, parent_tool_use_id: null } as SDKMessage
    const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] }, parent_tool_use_id: null } as SDKMessage
    const result = { type: 'result', subtype: 'success', session_id: 'port-session', usage: { input_tokens: 0, output_tokens: 0 } } as SDKMessage
    h.instance.persistSDKMessages('port-session', [partial, plainUser, complete, toolResult, result], 20)
    expect(persisted.map(message => message.type)).toEqual(['assistant', 'user', 'result'])
    expect(persisted[0]).toMatchObject({ uuid: 'complete' })
    expect(persisted[2]).toMatchObject({ _durationMs: 20 })
    expect(persisted.every(message => typeof (message as { _createdAt?: number })._createdAt === 'number')).toBe(true)
    sessions.appendMessages = () => { throw new Error('session write failed') }
    expect(() => h.instance.persistSDKMessages('port-session', [complete])).toThrow('session write failed')
    h.manager.dispose()
  })

  test('Given an injected transcript When regenerating title Then reads, revision guard and metadata writes stay within the port', async () => {
    let meta: AgentSessionMeta = { id: 'port-title', title: 'old', createdAt: 1, updatedAt: 1, revision: 1 }
    const writes: Array<Partial<AgentSessionMeta>> = []
    const sessions: SessionPort = {
      getMeta: () => meta,
      getMessages: () => [{ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '实现一个购物管理系统' }] } } as SDKMessage],
      appendMessages() {},
      updateMeta: (_id, patch) => { writes.push(patch); meta = { ...meta, ...patch } },
    }
    const h = fixture({ sessions })
    h.instance.generateTitle = async () => '购物管理系统'
    await expect(h.instance.regenerateTitle(meta.id, 'channel', 'model')).resolves.toBe('购物管理系统')
    expect(writes[0]).toMatchObject({ title: '购物管理系统' })
    h.instance.generateTitle = async () => { meta = { ...meta, revision: 2 }; return '过期标题' }
    await expect(h.instance.regenerateTitle(meta.id, 'channel', 'model')).rejects.toThrow('生成期间会话状态已变化')
    expect(writes).toHaveLength(1)
    h.manager.dispose()
  })

  test('Given a running session When queuing a user message Then adapter acceptance precedes port persistence and the skill notice follows the user message', async () => {
    const order: string[] = []
    const sessions: SessionPort = {
      getMeta: () => ({ id: 'port-queue', title: 'fixture', agentRuntime: 'pi', createdAt: 1, updatedAt: 1 }),
      updateMeta() {},
      appendMessages: (_id, messages) => { order.push(...messages.map(message => `persist:${message.type}`)) },
    }
    const h = fixture({ sessions }, { sendQueuedMessage: async () => { order.push('adapter') } })
    // 执行权在共享登记表里（activeSessions 是它的只读视图）。
    h.ownership.claim({ sessionId: 'port-queue', runtime: 'pi', token: 'run-1' })
    h.instance.activeSkillRoutings.set('port-queue', Promise.resolve({}))
    h.instance.activeRuntimeRegistrations.set('port-queue', Promise.resolve(true))
    expect(await h.instance.queueMessage('port-queue', 'queue', undefined, undefined, 'queue-1')).toBe('queue-1')
    expect(order).toEqual(['adapter', 'persist:user', 'persist:system'])
    await h.instance.queueMessage('port-queue', 'retry', undefined, undefined, 'queue-1')
    expect(order).toHaveLength(3)
    h.manager.dispose()
  })

  test('Given a queue accepted by the adapter When session persistence fails Then the UUID remains reserved and retry does not reinject', async () => {
    let accepted = 0
    let writes = 0
    const sessions: SessionPort = {
      getMeta: () => ({ id: 'failed-queue', title: 'fixture', agentRuntime: 'pi', createdAt: 1, updatedAt: 1 }),
      updateMeta() {},
      appendMessages: () => { writes++; throw new Error('write failed') },
    }
    const h = fixture({ sessions }, { sendQueuedMessage: async () => { accepted++ } })
    h.ownership.claim({ sessionId: 'failed-queue', runtime: 'pi', token: 'run-1' })
    h.instance.activeSkillRoutings.set('failed-queue', Promise.resolve({}))
    h.instance.activeRuntimeRegistrations.set('failed-queue', Promise.resolve(true))
    await expect(h.instance.queueMessage('failed-queue', 'queue', undefined, undefined, 'fixed-uuid')).resolves.toBe('fixed-uuid')
    await h.instance.queueMessage('failed-queue', 'retry', undefined, undefined, 'fixed-uuid')
    expect(accepted).toBe(1)
    expect(writes).toBe(2) // 用户消息和后置 notice 都尝试写入，重复 UUID 不再写入。
    h.manager.dispose()
  })

  test('Given the legacy constructor When permissions are requested Then the complete host adapter remains available', async () => {
    const h = fixture()
    const canUseTool = h.instance.permissionPort.createCanUseTool!({ sessionId: 'legacy-permission', sendPermissionRequest() { throw new Error('只读工具不应请求审批') } })
    await expect(canUseTool('Read', { file_path: '/safe/file' }, { signal: new AbortController().signal })).resolves.toMatchObject({ behavior: 'allow' })
    expect(typeof h.instance.permissionPort.handleAskUserQuestion).toBe('function')
    expect(typeof h.instance.permissionPort.handleExitPlanMode).toBe('function')
    h.manager.dispose()
  })

  test('Given injected permissions When the constructor selects a port Then the supplied port is kept', () => {
    const permissions = { clearSessionPending() {} }
    const h = fixture({ permissions })
    expect(h.instance.permissionPort).toBe(permissions)
    h.manager.dispose()
  })

  test('Given injected preview When orchestrator is constructed Then it uses the port without calling the legacy viewer manager', async () => {
    const ready = { ...identity, requestId: open.requestId, status: 'ready' as const, slideCount: 1, currentSlide: 1 }
    const inspected = { ...inspect, slideCount: 1, currentSlide: 1, images: [{ page: 1, data: 'fixture-image', mediaType: 'image/png' as const }] }
    const preview: PreviewPort = {
      open: async (event) => { expect(event).toBe(open); return ready },
      inspect: async (request) => { expect(request).toBe(inspect); return inspected },
    }
    const h = fixture({ preview })
    expect(h.instance.previewPort).toBe(preview)
    expect(await h.instance.previewPort.open(open)).toBe(ready)
    expect(await h.instance.previewPort.inspect(inspect)).toBe(inspected)
    expect(h.events).toEqual([])
    expect(h.manager.reportReady(ready)).toBe(false)
    h.manager.dispose()
  })

  test('Given no preview port When the legacy constructor opens and inspects Then both requests emit and matching receipts resolve', async () => {
    const h = fixture()
    const opened = h.instance.previewPort.open(open)
    h.manager.reportReady({ ...open, status: 'ready', slideCount: 1, currentSlide: 1 })
    await expect(opened).resolves.toMatchObject({ status: 'ready' })
    const inspected = h.instance.previewPort.inspect(inspect)
    h.manager.reportInspection({ ...inspect, slideCount: 1, currentSlide: 1, images: [{ page: 1, data: 'fixture-image', mediaType: 'image/png' }] })
    await expect(inspected).resolves.toMatchObject({ slideCount: 1 })
    expect(h.events).toEqual([
      { sessionId: identity.sessionId, payload: { kind: 'profer_event', event: open } },
      { sessionId: identity.sessionId, payload: { kind: 'profer_event', event: { type: 'preview_inspection_requested', request: inspect } } },
    ])
    h.manager.dispose()
  })

  test('Given injected tool assembly When builtin tools are built Then SDK, context and availability are preserved without fallback', async () => {
    const sdk = { fixture: 'sdk' }
    const context = { sessionId: 'session-seam', channelId: 'channel-seam' }
    const result = { tools: [{ name: 'injected-tool' }], collaborationAvailable: true }
    const toolAssembly: ToolAssemblyPort = { build: async (input) => {
      expect(input.sdk).toBe(sdk)
      expect(input.context).toBe(context)
      return result
    } }
    const h = fixture({ toolAssembly })
    expect(await h.instance.buildPiBuiltinTools(sdk, context)).toBe(result)
    expect(h.legacyBuilds()).toBe(0)
    h.manager.dispose()
  })

  test('Given production prepared query entry When adapter starts Then preset prompt, dynamic permission and frozen tools reach it with current retry credentials', async () => {
    const calls: string[] = []
    const callback = async () => ({ behavior: 'allow' as const, updatedInput: {} })
    const tools = [{ name: 'frozen' }]
    const prepared: AgentRuntimePreparedContext = { resources: {}, canUseTool: callback, tools, skills: [], mcpServers: {}, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'frozen policy' } }
    const h = fixture({ queryPreparation: { prepare: async (input, signal) => {
      expect(signal.aborted).toBe(false)
      calls.push(`prepare:${input.prepared?.credentials?.apiKey}`)
      return createAgentQueryPreparationPort({}).prepare(input, signal)
    } } }, { query: (input: { prepared: AgentRuntimePreparedContext; env: object }) => {
      calls.push(`query:${input.prepared.credentials?.apiKey}`)
      expect(input.prepared.systemPrompt).toBe(prepared.systemPrompt)
      expect(input.prepared.tools).toBe(tools)
      expect(input.prepared.canUseTool).toBe(callback)
      expect(input.env).toEqual({ HOST: 'keep' })
      return (async function* () {})()
    } })
    for (const apiKey of ['initial', 'refreshed']) {
      await h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'claude', prompt: 'turn', channelId: 'c', prepared: { ...prepared, credentials: { apiKey, baseUrl: undefined, provider: 'anthropic', forceBearerAuth: true } } }, { sessionId: 's', prompt: 'turn', env: { HOST: 'keep' } })
    }
    expect(calls).toEqual(['prepare:initial', 'query:initial', 'prepare:refreshed', 'query:refreshed'])
    expect(h.instance.queryPreparations.size).toBe(0)
    h.manager.dispose()
  })

  test('Given a custom preparation returns a partial snapshot When provider starts Then existing prepared fields are preserved', async () => {
    const existing = { credentials: { apiKey: 'keep', baseUrl: undefined, provider: 'anthropic' as const, forceBearerAuth: false }, tools: [{ name: 'keep' }], systemPrompt: 'keep prompt' }
    let received: AgentRuntimePreparedContext | undefined
    const h = fixture({ queryPreparation: { prepare: async () => ({ resources: { systemPrompt: 'partial' } }) } }, { query: (input: { prepared: AgentRuntimePreparedContext }) => { received = input.prepared; return (async function* () {})() } })
    await h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'pi', prompt: 'turn', prepared: existing }, { sessionId: 's', prompt: 'turn' })
    expect(received).toMatchObject({ credentials: existing.credentials, tools: existing.tools, systemPrompt: existing.systemPrompt, resources: { systemPrompt: 'partial' } })
    h.manager.dispose()
  })

  test('Given stop during provider preparation When an uncooperative builder resolves Then adapter never starts and preparation scope clears', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const h = fixture({ queryPreparation: { prepare: async () => { await gate; return {} } } }, { query: () => { calls++; return (async function* () {})() } })
    const pending = h.instance.queryPreparedProvider({ sessionId: 's', runtime: 'pi', prompt: 'turn' }, { sessionId: 's', prompt: 'turn' })
    h.instance.queryPreparations.get('s')!.abort(new Error('stopped'))
    release()
    await expect(pending).rejects.toThrow('stopped')
    expect(calls).toBe(0)
    expect(h.instance.queryPreparations.size).toBe(0)
    h.manager.dispose()
  })

  test('Given no tool assembly port When builtin tools are built Then the legacy builder still runs', async () => {
    const h = fixture()
    expect(await h.instance.buildPiBuiltinTools({}, { sessionId: 'session-seam', channelId: 'channel-seam' })).toBe(h.builtinResult)
    expect(h.legacyBuilds()).toBe(1)
    h.manager.dispose()
  })
})
