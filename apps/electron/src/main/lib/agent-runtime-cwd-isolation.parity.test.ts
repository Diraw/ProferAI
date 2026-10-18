/**
 * cwd 隔离对照：remote / automation / bridge 的会话 cwd 必须与旧链同源，且并发会话之间不串线。
 *
 * 背景（本文件要防的回归）：
 * 新 runtime 分支曾经让 remote / automation 显式传 `cwd = getAgentWorkspacePath(slug)`（workspace 根），
 * 而旧链（`AgentOrchestrator.sendMessage`）一律用 `getAgentSessionWorkspacePath(slug, sessionId)`，
 * 无 workspace 时用用户主目录。结果是同一工作区里的多个 remote / automation 会话共享 cwd、
 * Pi checkpoint 与相对路径文件互相污染。
 *
 * 证据方式：切片编译**真实** `agent-service.ts` 的 `buildRuntimeHeadlessRunContext`（不手抄旧逻辑），
 * 再用**真实** `AgentRuntimeCoordinator` 并发跑两个会话，断言每个会话拿到自己的 cwd 与 checkpoint 根。
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { AgentRuntimeCoordinator } from '@profer/agent-runtime'
import type { AgentSendInput, SDKMessage } from '@profer/shared'
import { compileSlice, readMainSource, sliceBetween } from './runtime-migration-parity/support/compile-slice'

const agentServiceSource = readMainSource('agent-service.ts')
const BASE_SLICE_START = 'function buildRuntimeHeadlessRunContext('
const BASE_SLICE_END = '/**\n * 解析本轮的有效策略上下文'

const WORKSPACE_ID = 'parity-workspace'
const WORKSPACE_SLUG = 'parity-ws'
const WORKSPACE_ROOT = '/parity/agent-workspaces/parity-ws'
const HOME_DIR = '/parity/home'

/** 每个 session 的 checkpoint 请求记录（sessionId → cwd），用于证明不串线。 */
const checkpointRequests: Array<{ sessionId: string; cwd: string }> = []

const buildRuntimeHeadlessRunContext = compileSlice<(input: AgentSendInput) => Record<string, unknown>>(
  sliceBetween(agentServiceSource, BASE_SLICE_START, BASE_SLICE_END, 'base-run-context'),
  'buildRuntimeHeadlessRunContext',
  {
    getAgentSessionMeta: () => undefined,
    normalizeAgentRuntime: (value: unknown) => value ?? 'pi',
    getAgentWorkspace: (workspaceId: string) => workspaceId === WORKSPACE_ID ? { id: WORKSPACE_ID, slug: WORKSPACE_SLUG } : undefined,
    getAgentSessionWorkspacePath: (slug: string, sessionId: string) => join('/parity/agent-workspaces', slug, sessionId),
    getAgentWorkspacePath: (slug: string) => join('/parity/agent-workspaces', slug),
    homedir: () => HOME_DIR,
    resolveRuntimeHeadlessPolicyContext: () => undefined,
    beginPiCheckpointTurn: (options: { sessionId: string; cwd: string }) => {
      checkpointRequests.push({ sessionId: options.sessionId, cwd: options.cwd })
      return { resolveCheckpointPatch: () => undefined }
    },
  },
)

function sendInput(sessionId: string, workspace: boolean): AgentSendInput {
  return {
    sessionId,
    channelId: 'parity-channel',
    userMessage: 'hello',
    agentRuntime: 'pi',
    ...(workspace ? { workspaceId: WORKSPACE_ID } : {}),
  } as unknown as AgentSendInput
}

describe('会话 cwd 语义（与旧链同源）', () => {
  test('Given 同一 workspace 的两个会话 When 解析运行环境 Then cwd 是各自的会话目录而不是 workspace 根', () => {
    checkpointRequests.length = 0
    const first = buildRuntimeHeadlessRunContext(sendInput('session-a', true))
    const second = buildRuntimeHeadlessRunContext(sendInput('session-b', true))

    expect(first.cwd).toBe(join(WORKSPACE_ROOT, 'session-a'))
    expect(second.cwd).toBe(join(WORKSPACE_ROOT, 'session-b'))
    // 回归防线：绝不能退化成 workspace 根（那会让两个会话共享目录与 Pi checkpoint）。
    expect(first.cwd).not.toBe(WORKSPACE_ROOT)
    expect(second.cwd).not.toBe(WORKSPACE_ROOT)
    expect(first.cwd).not.toBe(second.cwd)
  })

  test('Given 无 workspace 的会话 When 解析运行环境 Then 回退用户主目录而不是 process.cwd()', () => {
    checkpointRequests.length = 0
    const context = buildRuntimeHeadlessRunContext(sendInput('session-no-workspace', false))

    expect(context.cwd).toBe(HOME_DIR)
    expect(context.cwd).not.toBe(process.cwd())
  })

  test('Given Pi 会话 When 解析运行环境 Then checkpoint 生命周期拿到本会话自己的 cwd', () => {
    checkpointRequests.length = 0
    buildRuntimeHeadlessRunContext(sendInput('session-a', true))
    buildRuntimeHeadlessRunContext(sendInput('session-b', true))

    expect(checkpointRequests).toEqual([
      { sessionId: 'session-a', cwd: join(WORKSPACE_ROOT, 'session-a') },
      { sessionId: 'session-b', cwd: join(WORKSPACE_ROOT, 'session-b') },
    ])
  })
})

describe('并发会话不串线（真实 coordinator）', () => {
  test('Given 两个会话并发运行 Then 各自的 provider 只看到自己的 cwd，终态也各归各的', async () => {
    checkpointRequests.length = 0
    const seen: Array<{ sessionId: string; cwd: string | undefined }> = []
    const outcomes = new Map<string, unknown>()
    const coordinator = new AgentRuntimeCoordinator({
      adapters: {
        pi: {
          runtime: 'pi',
          stream: (query) => {
            seen.push({ sessionId: query.sessionId, cwd: query.cwd })
            return (async function* stream(): AsyncGenerator<SDKMessage> {
              yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
            })()
          },
          query: async () => ({ status: 'completed' }),
        },
      },
      ports: { sessions: { getMeta: () => undefined, appendMessages: () => undefined, updateMeta: () => undefined } },
    })

    const runs = ['session-a', 'session-b'].map((sessionId) => {
      const context = buildRuntimeHeadlessRunContext(sendInput(sessionId, true))
      return coordinator.run({
        sessionId,
        runtime: 'pi',
        prompt: 'hello',
        cwd: context.cwd as string,
      }).promise.then((outcome) => { outcomes.set(sessionId, outcome) })
    })

    await Promise.all(runs)

    expect(seen).toEqual([
      { sessionId: 'session-a', cwd: join(WORKSPACE_ROOT, 'session-a') },
      { sessionId: 'session-b', cwd: join(WORKSPACE_ROOT, 'session-b') },
    ])
    expect(outcomes.get('session-a')).toEqual({ status: 'completed' })
    expect(outcomes.get('session-b')).toEqual({ status: 'completed' })
    expect(checkpointRequests).toEqual([
      { sessionId: 'session-a', cwd: join(WORKSPACE_ROOT, 'session-a') },
      { sessionId: 'session-b', cwd: join(WORKSPACE_ROOT, 'session-b') },
    ])
    expect(coordinator.isRunning('session-a')).toBe(false)
    expect(coordinator.isRunning('session-b')).toBe(false)
  })
})
