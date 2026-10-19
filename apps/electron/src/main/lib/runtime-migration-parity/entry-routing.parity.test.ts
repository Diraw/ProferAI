/**
 * runtime-migration-parity / 入口路由对照（重点 1）
 *
 * 目标：把"哪个入口走旧链、哪个入口走新链、切换条件是什么"固化成**可执行**断言，
 * 而不是文档里的一句话。所有断言都读真实源码或执行真实函数。
 *
 * 证据规则：
 * - 路由条件用真实函数执行（`canUseRuntimeHeadless` 直接从 agent-service.ts 切片编译）。
 * - 其余用源码片段断言 + 开关读取点计数，防止"文档与实际代码漂移"。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSendInput } from '@profer/shared'
import { compileSlice, countOccurrences, expectSnippets, readMainSource, sliceBetween } from './support/compile-slice'

const agentServiceSource = readMainSource('agent-service.ts')
const remoteServiceSource = readMainSource('remote-service.ts')
const automationSchedulerSource = readMainSource('automation-scheduler.ts')
const ipcSource = readMainSource('../ipc.ts')

const mainLibDir = new URL('../../', import.meta.url)

/** 全入口共享的路由表；下面的断言逐条钉住它，表格不会静默失效。 */
export const ROUTING_TABLE = [
  { entry: 'desktop send_message', switch: 'PROFER_RUNTIME_DESKTOP', condition: "==='1' 才启用新链；无值 / 非 1 值走旧链，且无 Goal 回调", evidence: 'agent-service.ts runAgent → resolveDesktopRunChain（读取点在 agent-runtime-desktop-switch.ts）' },
  { entry: 'goal run / goal 续跑', switch: 'PROFER_RUNTIME_HEADLESS', condition: 'goalRunId / reportGoalResult / onRuntimeSessionId / onRuntimeMessage 任一存在即回旧链', evidence: 'canUseRuntimeHeadless 执行结果' },
  { entry: 'headless（飞书 Bridge / 协作 / agent-fabric）', switch: 'PROFER_RUNTIME_HEADLESS', condition: "==='1' 且无 goal 回调", evidence: 'canUseRuntimeHeadless 执行结果' },
  { entry: 'remote / Pocket send_message', switch: 'PROFER_RUNTIME_REMOTE', condition: "==='1' → runAgentRuntimeHeadless（绕过 runAgentHeadless）", evidence: 'remote-service.ts 分支片段' },
  { entry: 'automation', switch: 'PROFER_RUNTIME_AUTOMATION', condition: "==='1' → runAgentRuntimeHeadless（绕过 runAgentHeadless）", evidence: 'automation-scheduler.ts 分支片段' },
] as const

const headlessGateSource = sliceBetween(
  agentServiceSource,
  'function canUseRuntimeHeadless(',
  '/**\n * 将完整 headless 输入交给 runtime coordinator',
  'canUseRuntimeHeadless',
)
const canUseRuntimeHeadless = compileSlice<(input: AgentSendInput) => boolean>(headlessGateSource, 'canUseRuntimeHeadless', {})

function withHeadlessFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.PROFER_RUNTIME_HEADLESS
  if (value === undefined) delete process.env.PROFER_RUNTIME_HEADLESS
  else process.env.PROFER_RUNTIME_HEADLESS = value
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.PROFER_RUNTIME_HEADLESS
    else process.env.PROFER_RUNTIME_HEADLESS = previous
  }
}

const baseInput: AgentSendInput = { sessionId: 'parity-session', channelId: 'parity-channel', userMessage: 'hello' }

describe('入口路由表与真实条件', () => {
  test('headless 门禁真值表：仅 flag=1 且无 goal 回调时走新 coordinator', () => {
    const cases: Array<{ label: string; flag?: string; input: Partial<AgentSendInput>; expected: boolean }> = [
      { label: 'flag 缺失', flag: undefined, input: {}, expected: false },
      { label: "flag='0'", flag: '0', input: {}, expected: false },
      { label: "flag='1' 普通输入", flag: '1', input: {}, expected: true },
      { label: "flag='1' + goalRunId", flag: '1', input: { goalRunId: 'goal-1' }, expected: false },
      { label: "flag='1' + reportGoalResult", flag: '1', input: { reportGoalResult: () => undefined }, expected: false },
      { label: "flag='1' + onRuntimeSessionId", flag: '1', input: { onRuntimeSessionId: () => undefined }, expected: false },
      { label: "flag='1' + onRuntimeMessage", flag: '1', input: { onRuntimeMessage: () => undefined }, expected: false },
      { label: "flag='1' + 其它 flag 无关字段", flag: '1', input: { triggeredBy: 'automation', permissionModeOverride: 'plan' }, expected: true },
    ]
    for (const item of cases) {
      expect(withHeadlessFlag(item.flag, () => canUseRuntimeHeadless({ ...baseInput, ...item.input }))).toBe(item.expected)
    }
  })

  test('桌面 runAgent 仅在显式启用时走 runtime，且仍保留两条链', () => {
    const runAgentSlice = sliceBetween(agentServiceSource, 'export async function runAgent(', '/**\n * 直接使用 runtime coordinator 的 headless 入口', 'runAgent')
    // 开关读取点集中在 agent-runtime-desktop-switch.ts；runAgent 只调判定函数一次，不自读环境变量。
    expect(countOccurrences(runAgentSlice, 'resolveDesktopRunChain(')).toBe(1)
    expect(countOccurrences(runAgentSlice, 'PROFER_RUNTIME_')).toBe(0)
    expectSnippets(runAgentSlice, ['runDesktopRuntimeAgent(', 'orchestrator.sendMessage(', 'registerWebContents(', 'AgentRunAlreadyActiveError', 'AgentSessionRuntimeMismatchError'], 'runAgent')
  })

  test('四个开关互相独立，全仓仅在各自入口读取一次', () => {
    expect(countOccurrences(agentServiceSource, 'PROFER_RUNTIME_HEADLESS')).toBe(1)
    expect(countOccurrences(remoteServiceSource, 'PROFER_RUNTIME_REMOTE')).toBe(1)
    expect(countOccurrences(automationSchedulerSource, 'PROFER_RUNTIME_AUTOMATION')).toBe(1)
    expect(countOccurrences(readMainSource('agent-runtime-desktop-switch.ts'), 'PROFER_RUNTIME_DESKTOP')).toBe(1)

    // 扫描 main 进程与 packages，确认没有第 5 个入口偷偷读同一个开关。
    const offenders: string[] = []
    for (const file of walkTypeScript(mainLibDir)) {
      if (file.includes('runtime-migration-parity')) continue
      if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) continue
      const source = readFileSync(file, 'utf8')
      for (const flag of ['PROFER_RUNTIME_HEADLESS', 'PROFER_RUNTIME_REMOTE', 'PROFER_RUNTIME_AUTOMATION', 'PROFER_RUNTIME_DESKTOP']) {
        if (source.includes(flag)) offenders.push(`${file.split('/apps/').at(-1)} → ${flag}`)
      }
    }
    expect(offenders.sort()).toEqual([
      'electron/src/main/lib/agent-runtime-desktop-switch.ts → PROFER_RUNTIME_DESKTOP',
      'electron/src/main/lib/agent-service.ts → PROFER_RUNTIME_HEADLESS',
      'electron/src/main/lib/automation-scheduler.ts → PROFER_RUNTIME_AUTOMATION',
      'electron/src/main/lib/remote-service.ts → PROFER_RUNTIME_REMOTE',
    ])
  })

  test('remote / automation 的新分支与旧分支共用同一组 callbacks，拒绝在副作用前同步返回', () => {
    const remoteBranch = sliceBetween(remoteServiceSource, 'const useRuntimeRemote = process.env.PROFER_RUNTIME_REMOTE', 'void runtimeRun.catch', 'remote-branch')
    expectSnippets(remoteBranch, [
      "process.env.PROFER_RUNTIME_REMOTE === '1'",
      'peekAgentRunClaimFailureForSession(',
      '{ ok: false, error: describeAgentRunRejection(remoteBlocked) }',
      'runAgentRuntimeHeadless(',
      ': runAgentHeadless(headlessInput, {',
    ], 'remote-branch')
    // 旧分支自己构造 run_completed（含 resultErrors/backgroundTasksPending），新分支把投影留给 host event port。
    expect(remoteBranch).toContain('type: \'run_completed\'')
    expect(remoteBranch).toContain('backgroundTasksPending')
    const newBranch = remoteBranch.slice(remoteBranch.indexOf('useRuntimeRemote\n        ?'), remoteBranch.indexOf(': runAgentHeadless'))
    expect(newBranch).not.toContain('run_completed')
    expect(newBranch).not.toContain('backgroundTasksPending')

    const automationBranch = sliceBetween(automationSchedulerSource, 'const useRuntimeAutomation = process.env.PROFER_RUNTIME_AUTOMATION', 'runtimeRun.catch', 'automation-branch')
    expectSnippets(automationBranch, [
      "process.env.PROFER_RUNTIME_AUTOMATION === '1'",
      'peekAgentRunClaimFailureForSession(',
      "status: 'skipped',",
      'runAgentRuntimeHeadless(',
      ': runAgentHeadless(headlessInput, callbacks)',
    ], 'automation-branch')
  })

  test('Goal 归属仍由旧 orchestrator 记录；新路径没有 goal owner 概念', () => {
    const orchestratorSource = readMainSource('agent-orchestrator.ts')
    expectSnippets(orchestratorSource, [
      'goalRunOwners.set(sessionId, input.goalRunId)',
      'isGoalRunActive(sessionId: string, runId?: string)',
      'stopGoalRunAndWait(',
    ], 'goal-owner')
    // goal 输入被显式排除出新路径，因此 owner 只可能登记在旧链。
    expect(withHeadlessFlag('1', () => canUseRuntimeHeadless({ ...baseInput, goalRunId: 'goal-1' }))).toBe(false)
  })

  test('ownership 查询与 headless runner 都只有一个来源被"或"起来（R1/R2 现状证据）', () => {
    expectSnippets(agentServiceSource, [
      'setAgentSessionActiveChecker((sessionId) => orchestrator.isActive(sessionId) || runtimeCoordinator.isRunning(sessionId))',
      'setHeadlessAgentRunner((input, callbacks) => runAgentHeadless(input, callbacks))',
    ], 'ownership-composition')

    const orchestratorSource = readMainSource('agent-orchestrator.ts')
    expectSnippets(orchestratorSource, [
      'setHeadlessAgentRunner((input, callbacks) => this.sendMessage(input, callbacks))',
    ], 'orchestrator-registration')

    // 两个注册点：orchestrator 构造期先注册，agent-service 模块末尾覆盖。后写者生效 => 任何再次
    // 实例化 orchestrator 的代码都会静默改掉 headless 执行链（R1）。
    const registrationCount = countOccurrences(orchestratorSource, 'setHeadlessAgentRunner(')
      + countOccurrences(agentServiceSource, 'setHeadlessAgentRunner(')
    expect(registrationCount).toBe(2)
    const serviceRegistrationIndex = agentServiceSource.indexOf('setHeadlessAgentRunner((input, callbacks) => runAgentHeadless(input, callbacks))')
    const orchestratorConstructionIndex = agentServiceSource.indexOf('const orchestrator = new AgentOrchestrator(')
    expect(orchestratorConstructionIndex).toBeGreaterThan(-1)
    expect(serviceRegistrationIndex).toBeGreaterThan(orchestratorConstructionIndex)
  })

  test('桌面 IPC 入口没有 runtime 分支', () => {
    const sendMessageSlice = sliceBetween(ipcSource, 'AGENT_IPC_CHANNELS.SEND_MESSAGE', '\n  })', 'ipc-send-message')
    expectSnippets(sendMessageSlice, ['runAgent('], 'ipc-send-message')
    expect(countOccurrences(ipcSource, 'PROFER_RUNTIME_')).toBe(0)
  })
})

/** 递归收集 main/lib 下的 TS 文件（跳过 node_modules / dist / 隐藏目录）。 */
function walkTypeScript(root: URL): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(child)
        continue
      }
      if (/\.tsx?$/.test(entry.name)) out.push(child)
    }
  }
  visit(root.pathname)
  return out
}
