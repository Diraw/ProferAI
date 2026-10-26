/**
 * Fabric headless 执行器：内核选择与渠道能力校验。
 *
 * 回归点（P1-7）：建会话曾硬编码 'claude'，全局默认 Pi、渠道只开放 Pi 时
 * Fabric 任务必然失败，且失败原因埋在 SDK 层。这里锁定两件事：
 * 1. 会话内核跟随 settings.agentRuntime；
 * 2. 渠道不支持该内核时，任务以明确原因失败，且不建会话、不启动 runner。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, ChannelsConfig } from '@profer/shared'
import type { AgentTask, TaskExecution, TaskReporter, TaskResult } from '@profer/agent-fabric'

const configDir = mkdtempSync(join(tmpdir(), 'profer-fabric-executor-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

/** 由各用例改写；mock 工厂读的是同一个对象引用。 */
const settingsState: { agentRuntime?: AgentRuntime; agentChannelId?: string; agentModelId?: string } = {
  agentRuntime: 'pi',
  agentChannelId: 'pi-only-channel',
  agentModelId: 'pi-model',
}

const createdSessions: Array<{ channelId?: string; modelId?: string; runtime?: AgentRuntime }> = []
const runnerCalls: Array<{ sessionId: string; channelId?: string; modelId?: string }> = []

mock.module('../settings-service', () => ({ getSettings: () => settingsState }))
mock.module('../agent-session-manager', () => ({
  createAgentSession: (
    _title: string | undefined,
    channelId: string | undefined,
    _workspaceId: string | undefined,
    modelId: string | undefined,
    runtime: AgentRuntime,
  ) => {
    createdSessions.push({ channelId, modelId, runtime })
    return { id: `session-${createdSessions.length}` }
  },
}))
mock.module('../agent-service', () => ({
  agentEventBus: { on: () => () => {} },
  stopAgent: async () => {},
}))
mock.module('../agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: async (
    input: { sessionId: string; channelId?: string; modelId?: string },
    handlers: { onComplete?: (messages: unknown[], opts?: { stoppedByUser?: boolean }) => void },
  ) => {
    runnerCalls.push({ sessionId: input.sessionId, channelId: input.channelId, modelId: input.modelId })
    handlers.onComplete?.([{ role: 'assistant', content: '任务完成' }])
  },
  stopRegisteredAgent: () => {},
}))

let executorModule: typeof import('./fabric-executor-headless')

function writeChannels(): void {
  const config: ChannelsConfig = {
    version: 1,
    channels: [
      {
        id: 'pi-only-channel',
        name: '仅 Pi 渠道',
        provider: 'custom',
        baseUrl: 'https://example.com/v1',
        agentBaseUrl: 'https://example.com/v1',
        apiKey: 'test-secret',
        models: [{ id: 'pi-model', name: 'Pi 模型', enabled: true }],
        enabled: true,
        agentRuntimes: ['pi'],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'claude-only-channel',
        name: '仅 Claude 渠道',
        provider: 'anthropic',
        baseUrl: 'https://example.com/v1',
        apiKey: 'test-secret',
        models: [{ id: 'claude-model', name: 'Claude 模型', enabled: true }],
        enabled: true,
        agentRuntimes: ['claude'],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
  writeFileSync(channelsPath, JSON.stringify(config, null, 2), 'utf-8')
}

/** 执行器只消费 defaultChannelId；其余字段仅为满足配置类型。 */
function fabricConfig(channelId: string): import('./fabric-config').AgentFabricConfig {
  return { enabled: true, host: '127.0.0.1', port: 4788, agentId: 'profer-stable', defaultChannelId: channelId }
}

interface ExecutionHarness {
  execution: TaskExecution
  done: Promise<{ failed?: string; completed?: TaskResult }>
}

function createExecution(taskId: string): ExecutionHarness {
  let resolveDone!: (value: { failed?: string; completed?: TaskResult }) => void
  const done = new Promise<{ failed?: string; completed?: TaskResult }>((resolve) => { resolveDone = resolve })
  const reporter: TaskReporter = {
    progress: () => {},
    artifactCreated: () => {},
    complete: (result) => resolveDone({ completed: result }),
    fail: (reason) => resolveDone({ failed: reason }),
  }
  const task = {
    request: {
      taskId,
      rootTaskId: taskId,
      requesterAgentId: 'requester',
      orchestratorAgentId: 'orchestrator',
      targetAgentId: 'local',
      objective: '验证 Fabric 内核选择',
      workspaceId: '',
      constraints: [],
      dependsOn: [],
      policy: {},
      submittedAt: 1,
    },
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as AgentTask
  return { execution: { task, reporter }, done }
}

beforeAll(async () => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels()
  executorModule = await import('./fabric-executor-headless')
})

beforeEach(() => {
  createdSessions.length = 0
  runnerCalls.length = 0
  settingsState.agentRuntime = 'pi'
  settingsState.agentChannelId = 'pi-only-channel'
  settingsState.agentModelId = 'pi-model'
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('Fabric headless 执行器内核选择', () => {
  test('全局默认 Pi 且渠道只开放 Pi 时，会话使用 Pi 并正常启动 runner', async () => {
    const executor = executorModule.createHeadlessTaskExecutor({ config: fabricConfig('pi-only-channel') })
    const { execution, done } = createExecution('task-pi')

    executor.start(execution)
    const outcome = await done

    expect(outcome.failed).toBeUndefined()
    expect(createdSessions).toEqual([{ channelId: 'pi-only-channel', modelId: 'pi-model', runtime: 'pi' }])
    expect(runnerCalls).toHaveLength(1)
    expect(runnerCalls[0]?.sessionId).toBe('session-1')
  })

  test('全局默认 Claude 但渠道只开放 Pi 时，明确失败且不建会话', async () => {
    settingsState.agentRuntime = 'claude'
    const executor = executorModule.createHeadlessTaskExecutor({ config: fabricConfig('pi-only-channel') })
    const { execution, done } = createExecution('task-runtime-mismatch')

    executor.start(execution)
    const outcome = await done

    expect(outcome.failed).toContain('仅 Pi 渠道')
    expect(outcome.failed).toContain('claude 内核')
    expect(createdSessions).toHaveLength(0)
    expect(runnerCalls).toHaveLength(0)
  })

  test('渠道 ID 不存在时，给出可定位的失败原因', async () => {
    settingsState.agentChannelId = 'missing-channel'
    const executor = executorModule.createHeadlessTaskExecutor({ config: fabricConfig('missing-channel') })
    const { execution, done } = createExecution('task-missing-channel')

    executor.start(execution)
    const outcome = await done

    expect(outcome.failed).toContain('渠道不存在')
    expect(outcome.failed).toContain('missing-channel')
    expect(createdSessions).toHaveLength(0)
  })

  test('全局默认 Pi 与仅 Claude 渠道组合时同样拒绝执行', async () => {
    settingsState.agentChannelId = 'claude-only-channel'
    const executor = executorModule.createHeadlessTaskExecutor({ config: fabricConfig('claude-only-channel') })
    const { execution, done } = createExecution('task-claude-only')

    executor.start(execution)
    const outcome = await done

    expect(outcome.failed).toContain('pi 内核')
    expect(createdSessions).toHaveLength(0)
  })
})
