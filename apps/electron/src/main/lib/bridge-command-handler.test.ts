import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, AgentSessionMeta, ChannelsConfig } from '@profer/shared'

// ===== 渠道配置夹具（真实 channel-manager 读取） =====
const configDir = mkdtempSync(join(tmpdir(), 'profer-bridge-command-handler-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function channel(
  id: string,
  agentRuntimes: Array<'pi' | 'claude'>,
): ChannelsConfig['channels'][number] {
  return {
    id,
    name: id,
    provider: 'custom',
    baseUrl: 'https://example.com/v1',
    agentBaseUrl: 'https://example.com/v1',
    apiKey: 'test-secret',
    models: [{ id: `${id}-model`, name: `${id} model`, enabled: true }],
    enabled: true,
    agentRuntimes,
    createdAt: 1,
    updatedAt: 1,
  }
}

function writeChannels(): void {
  writeFileSync(
    channelsPath,
    JSON.stringify({
      version: 1,
      channels: [channel('pi-only', ['pi']), channel('claude-only', ['claude']), channel('dual', ['pi', 'claude'])],
    }, null, 2),
    'utf-8',
  )
}

// ===== 设置夹具 =====
interface SettingsFixture {
  agentRuntime: AgentRuntime
  agentChannelId?: string
  agentModelId?: string
  agentWorkspaceId?: string
}

let settings: SettingsFixture = { agentRuntime: 'pi', agentChannelId: 'pi-only' }

// ===== 会话夹具 =====
interface CreatedSessionCall {
  title?: string
  channelId?: string
  workspaceId?: string
  modelId?: string
  agentRuntime?: AgentRuntime
}

const createdSessionCalls: CreatedSessionCall[] = []
const sessionMetas = new Map<string, AgentSessionMeta>()
let sessionSeq = 0

function seedSession(meta: Partial<AgentSessionMeta> & { id: string }): AgentSessionMeta {
  const full = {
    title: meta.id,
    channelId: 'pi-only',
    agentRuntime: 'pi',
    agentRuntimeLocked: true,
    createdAt: 1,
    updatedAt: 1,
    ...meta,
  } as AgentSessionMeta
  sessionMetas.set(full.id, full)
  return full
}

// ===== 被 mock 的本地依赖 =====
mock.module('./settings-service', () => ({
  getSettings: () => settings,
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (
    title?: string,
    channelId?: string,
    workspaceId?: string,
    modelId?: string,
    agentRuntime?: AgentRuntime,
  ) => {
    createdSessionCalls.push({ title, channelId, workspaceId, modelId, agentRuntime })
    const id = `session-${++sessionSeq}`
    return seedSession({
      id,
      title: title ?? '新会话',
      channelId,
      agentRuntime: agentRuntime ?? 'claude',
      agentRuntimeLocked: false,
    })
  },
  listAgentSessions: () => Array.from(sessionMetas.values()),
  getAgentSessionMeta: (id: string) => sessionMetas.get(id),
}))

const headlessCalls: Array<{ sessionId: string; channelId: string; modelId?: string }> = []

mock.module('./agent-service', () => ({
  runAgentHeadless: async (input: { sessionId: string; channelId: string; modelId?: string }) => {
    headlessCalls.push({ sessionId: input.sessionId, channelId: input.channelId, modelId: input.modelId })
  },
  agentEventBus: { on: () => () => {} },
  stopAgent: () => {},
  isAgentSessionActive: () => false,
}))

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => [],
  getAgentWorkspace: () => undefined,
  getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }),
}))

const { BridgeCommandHandler } = await import('./bridge-command-handler')

function createHandler(): { handler: InstanceType<typeof BridgeCommandHandler>; sent: string[] } {
  const sent: string[] = []
  const handler = new BridgeCommandHandler({
    platformName: '测试',
    source: 'dingtalk',
    adapter: {
      sendText: async (_chatId: string, text: string) => {
        sent.push(text)
      },
    },
  })
  return { handler, sent }
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels()
  settings = { agentRuntime: 'pi', agentChannelId: 'pi-only' }
  createdSessionCalls.length = 0
  headlessCalls.length = 0
  sessionMetas.clear()
  sessionSeq = 0
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('Bot 建会话使用全局 Agent 内核', () => {
  test('Given 全局内核 Pi 且默认渠道 Pi-only When 收到消息 Then 建会话传 pi 并写入 binding', async () => {
    const { handler, sent } = createHandler()

    await handler.handleIncomingMessage('chat-1', '你好')

    expect(createdSessionCalls).toHaveLength(1)
    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    expect(createdSessionCalls[0]?.channelId).toBe('pi-only')
    expect(handler.getBinding('chat-1')?.agentRuntime).toBe('pi')
    // 发送路径同样使用 Pi-only 渠道，而不是退回 Claude 渠道
    expect(headlessCalls[0]?.channelId).toBe('pi-only')
    expect(sent.some((line) => line.includes('Agent 处理中'))).toBe(true)
  })

  test('Given 全局内核 Pi When /new 建会话 Then 也传 pi', async () => {
    const { handler } = createHandler()

    await handler.handleIncomingMessage('chat-2', '/new 测试会话')

    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    expect(handler.getBinding('chat-2')?.agentRuntime).toBe('pi')
  })

  test('Given 默认渠道只勾选 Claude 而全局内核是 Pi When 建会话 Then 回退到 Pi 可用渠道并提示', async () => {
    settings = { agentRuntime: 'pi', agentChannelId: 'claude-only' }
    const { handler, sent } = createHandler()

    await handler.handleIncomingMessage('chat-3', '/new')

    expect(createdSessionCalls[0]?.channelId).toBe('pi-only')
    expect(createdSessionCalls[0]?.agentRuntime).toBe('pi')
    expect(sent.some((line) => line.includes('已自动改用其它可用渠道'))).toBe(true)
  })
})

describe('/model 按会话内核过滤', () => {
  test('Given Pi 会话 When 查看渠道列表 Then 不出现只勾选 Claude 的渠道', async () => {
    const { handler, sent } = createHandler()
    await handler.handleIncomingMessage('chat-4', 'hi')

    await handler.handleIncomingMessage('chat-4', '/model')

    const listMessage = sent.at(-1) ?? ''
    expect(listMessage).toContain('pi-only')
    expect(listMessage).toContain('dual')
    expect(listMessage).not.toContain('claude-only')
    expect(listMessage).toContain('当前内核: Pi')
  })

  test('Given 旧 binding 无 agentRuntime When 会话元数据是 Claude Then 按 Claude 过滤并允许切换', async () => {
    const { handler, sent } = createHandler()
    // 先用 Pi 建会话，再模拟旧持久化数据：binding 没有 agentRuntime，会话元数据是 Claude
    const binding = handler.ensureBinding('chat-5')
    expect(binding).not.toBeNull()
    delete binding!.agentRuntime
    seedSession({ id: binding!.sessionId, agentRuntime: 'claude', channelId: 'pi-only' })

    await handler.handleIncomingMessage('chat-5', '/model')
    const listMessage = sent.at(-1) ?? ''
    expect(listMessage).toContain('当前内核: Claude')
    expect(listMessage).toContain('claude-only')
    expect(listMessage).not.toContain('pi-only')

    // 序号 1 在 Claude 列表里是 claude-only，切换必须成功
    await handler.handleIncomingMessage('chat-5', '/model 1 1')
    expect(handler.getBinding('chat-5')?.channelId).toBe('claude-only')
  })

  test('Given Pi 会话 When 选择不存在的序号 Then 明确提示当前内核而不是静默失败', async () => {
    const { handler, sent } = createHandler()
    await handler.handleIncomingMessage('chat-6', 'hi')

    // Pi 可用渠道只有 2 个，序号 3 越界
    await handler.handleIncomingMessage('chat-6', '/model 3')

    const reply = sent.at(-1) ?? ''
    expect(reply).toContain('未找到渠道')
    expect(reply).toContain('当前内核: Pi')
    expect(handler.getBinding('chat-6')?.channelId).toBe('pi-only')
  })

  test('Given 没有该内核可用渠道 When 查看渠道列表 Then 给出明确提示', async () => {
    settings = { agentRuntime: 'claude', agentChannelId: 'pi-only' }
    writeFileSync(
      channelsPath,
      JSON.stringify({ version: 1, channels: [channel('pi-only', ['pi'])] }, null, 2),
      'utf-8',
    )
    const { handler, sent } = createHandler()
    // 无 binding 时按全局设置解析内核（Claude），但没有任何 Claude 渠道
    await handler.handleIncomingMessage('chat-7', '/model')

    const reply = sent.at(-1) ?? ''
    expect(reply).toContain('暂无同时启用该内核的可用渠道')
    expect(reply).toContain('Claude')
  })
})

describe('旧 binding 发送时渠道回退', () => {
  test('Given binding 指向未启用当前内核的渠道 When 发送消息 Then 回退到可用渠道而不是报错', async () => {
    const { handler } = createHandler()
    const binding = handler.ensureBinding('chat-8')
    expect(binding).not.toBeNull()
    // 旧数据：会话是 Pi，但渠道被改成了只勾选 Claude 的渠道
    binding!.channelId = 'claude-only'
    binding!.agentRuntime = 'pi'

    await handler.handleIncomingMessage('chat-8', '继续')

    expect(headlessCalls[0]?.channelId).toBe('pi-only')
    // 回退后必须按新渠道重新解析模型，不能把 undefined/旧渠道模型交给 orchestrator。
    expect(headlessCalls[0]?.modelId).toBe('pi-only-model')
  })
})
