/**
 * Electron 宿主侧集成测试。
 *
 * provider 自身的行为测试已迁到 packages/agent-provider-claude/src；
 * 这里只验证宿主边界：兼容转发仍指同一实现、Electron 生命周期端口与后台任务记录可用、
 * 以及宿主注入的应用版本让认证 env 与迁移前一致。
 *
 * SDK 与子进程都由测试内联替身提供，不启动真实 claude 进程、不发起网络请求。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgentAdapter as ProviderClaudeAdapter, type ClaudeSdkModule } from '@profer/agent-provider-claude'
import { BackgroundTaskManager } from '../background-task-manager'
import { createElectronClaudeProcessLifecyclePort } from '../claude-process-lifecycle-port'
import { applyAgentSdkAuthEnv } from '../agent-sdk-auth-env'
import {
  ClaudeAgentAdapter,
  friendlyErrorMessage,
  mapSDKErrorToTypedError,
  scanAndKillOrphanedClaudeSubprocesses,
  type ClaudeAgentQueryOptions,
} from './claude-agent-adapter'
import pkg from '../../../../package.json' with { type: 'json' }

interface FakeQuery {
  options: Record<string, unknown>
  stopTaskCalls: string[]
}

/** 最小 SDK 替身：只提供 adapter 实际调用的 query/close/stopTask。 */
function createInlineSdkDouble(): { module: ClaudeSdkModule; state: FakeQuery; push: (message: unknown) => void } {
  const queue: unknown[] = []
  const waiters: Array<(value: unknown) => void> = []
  const state: FakeQuery = { options: {}, stopTaskCalls: [] }
  const iterator = {
    async next() {
      if (queue.length > 0) return { value: queue.shift(), done: false }
      const value = await new Promise<unknown>((resolve) => waiters.push(resolve))
      return { value, done: false }
    },
    async return() {
      return { value: undefined, done: true }
    },
  }
  const queryObject = {
    [Symbol.asyncIterator]() {
      return iterator
    },
    async close() {},
    async stopTask(taskId: string) {
      state.stopTaskCalls.push(taskId)
    },
  }
  const module = {
    query(input: { options: Record<string, unknown> }) {
      state.options = input.options
      return queryObject
    },
  } as unknown as ClaudeSdkModule
  return {
    module,
    state,
    push(message: unknown) {
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    },
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('Electron 宿主：Claude 兼容转发', () => {
  test('Given 旧入口 paths When 导入 Then 与 provider 包导出同一实现', () => {
    expect(ClaudeAgentAdapter).toBe(ProviderClaudeAdapter)
    expect(typeof scanAndKillOrphanedClaudeSubprocesses).toBe('function')
    expect(typeof friendlyErrorMessage).toBe('function')
    expect(typeof mapSDKErrorToTypedError).toBe('function')
  })

  test('Given 旧入口 When 构造 adapter Then 宿主仍可只注入 processLifecycle', () => {
    const manager = new BackgroundTaskManager()
    const adapter = new ClaudeAgentAdapter({ processLifecycle: createElectronClaudeProcessLifecyclePort(manager) })
    try {
      expect(adapter.getCapabilities()).toMatchObject({ supportsTaskOutput: true, supportsTaskStop: true })
    } finally {
      adapter.dispose()
    }
  })
})

describe('Electron 宿主：后台任务权威与 provider 集成', () => {
  test('Given Electron 生命周期端口 When SDK 推送任务事件 Then 记录落在宿主 manager 且 provider 不双写', async () => {
    const sessionId = 'electron-task-authority'
    const manager = new BackgroundTaskManager()
    const port = createElectronClaudeProcessLifecyclePort(manager)
    const sdk = createInlineSdkDouble()
    const adapter = new ClaudeAgentAdapter({ processLifecycle: port, sdkLoader: async () => sdk.module })
    const dir = mkdtempSync(join(tmpdir(), 'electron-claude-task-'))
    const outputFile = join(dir, 'output.txt')
    writeFileSync(outputFile, 'host owned output')
    try {
      const queryInput: ClaudeAgentQueryOptions = {
        sessionId,
        prompt: 'fixture',
        sdkCliPath: '/unused/mock-claude',
        env: {},
        sdkPermissionMode: 'auto',
        allowDangerouslySkipPermissions: false,
        systemPrompt: 'test',
      }
      const stream = adapter.query(queryInput)[Symbol.asyncIterator]()
      const first = stream.next()
      await waitUntil(() => Object.keys(sdk.state.options).length > 0)
      sdk.push({ type: 'system', subtype: 'task_started', task_id: 'task', task_type: 'local_bash' })
      await first
      const second = stream.next()
      sdk.push({ type: 'system', subtype: 'task_progress', task_id: 'task', summary: 'working' })
      await second

      expect(manager.get(sessionId, 'task')).toMatchObject({ status: 'running', type: 'shell', summary: 'working' })
      expect(await adapter.getTaskOutput(sessionId, 'task', { block: false })).toMatchObject({ status: 'running' })
      await expect(adapter.stopTask('foreign', 'task')).rejects.toThrow('不属于当前会话')
      await adapter.stopTask(sessionId, 'task', 'shell')
      expect(sdk.state.stopTaskCalls).toEqual(['task'])
      expect(manager.get(sessionId, 'task')?.status).toBe('stopped')

      const third = stream.next()
      sdk.push({ type: 'system', subtype: 'task_notification', task_id: 'done', status: 'completed', output_file: outputFile })
      await third
      expect(await adapter.getTaskOutput(sessionId, 'done')).toMatchObject({ output: 'host owned output', status: 'completed' })

      const fourth = stream.next()
      sdk.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await fourth
      expect((await stream.next()).done).toBe(true)
    } finally {
      adapter.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Electron 宿主：认证 env 版本', () => {
  test('Given Electron 应用版本 When 计划渠道认证 Then User-Agent 与迁移前一致', () => {
    const env: Record<string, string | undefined> = {}
    applyAgentSdkAuthEnv(env, 'kimi-coding', 'secret')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('secret')
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(`Proma/${pkg.version}`)
  })
})
