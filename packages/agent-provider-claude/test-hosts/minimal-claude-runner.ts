#!/usr/bin/env bun
/**
 * 最小 Bun runner：在非 Electron 进程中使用真实抽出的 ClaudeAgentAdapter 跑完整生命周期。
 *
 * 运行：
 *   bun run packages/agent-provider-claude/test-hosts/minimal-claude-runner.ts
 *
 * 替身边界：
 * - SDK 模块（@anthropic-ai/claude-agent-sdk）：使用可控替身，不加载真实 SDK、不发起网络请求；
 * - 子进程：使用 FakeChildProcess，不真的 spawn claude CLI；
 * - 宿主后台任务端口：使用进程内 fixture，Electron 之外同样成立。
 * 真实 SDK 加载与真实在线调用分别单独报告，本 runner 不涉及凭据。
 *
 * 退出码：0 全部场景通过；1 存在失败场景。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgentAdapter, mapSDKErrorToTypedError, type ClaudeAgentQueryOptions } from '../src/index.ts'
import { BackgroundTaskManager } from '../src/background-task-manager.ts'
import { createClaudeSdkDouble, type ClaudeSdkDouble, type FakeChildProcess } from './claude-sdk-double.ts'
import { createFakeClaudeLifecyclePort } from './fake-claude-lifecycle-port.ts'

// ---------------------------------------------------------------------------
// 断言与报告
// ---------------------------------------------------------------------------

class RunnerAssertionError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RunnerAssertionError(message)
}

function equal(actual: unknown, expected: unknown, message: string): void {
  const a = canonical(actual)
  const e = canonical(expected)
  if (a !== e) throw new RunnerAssertionError(`${message}：期望 ${e}，实际 ${a}`)
}

/** 键顺序无关的稳定序列化，避免记录对象字段顺序影响断言。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new RunnerAssertionError(`${label}等待超时`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

interface ScenarioResult {
  name: string
  ok: boolean
  detail: string
  durationMs: number
}

async function runScenario(name: string, body: () => Promise<string>): Promise<ScenarioResult> {
  const startedAt = Date.now()
  try {
    const detail = await body()
    return { name, ok: true, detail, durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { name, ok: false, detail: message, durationMs: Date.now() - startedAt }
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

function createSession(sessionId: string, overrides: Partial<ClaudeAgentQueryOptions> = {}): ClaudeAgentQueryOptions {
  return {
    sessionId,
    prompt: 'runner fixture',
    sdkCliPath: '/unused/fake-claude',
    env: {},
    sdkPermissionMode: 'auto',
    allowDangerouslySkipPermissions: false,
    systemPrompt: 'runner system prompt',
    ...overrides,
  }
}

async function scenarioStreamAndCallbacks(): Promise<string> {
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  const sessionIds: string[] = []
  const models: string[] = []
  const contextWindows: number[] = []
  try {
    const stream = adapter.query(createSession('runner-stream', {
      model: 'runner-model',
      onSessionId: (id) => sessionIds.push(id),
      onModelResolved: (model) => models.push(model),
      onContextWindow: (size) => contextWindows.push(size),
    }))[Symbol.asyncIterator]()
    const first = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    double.push({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'runner-model' })
    const initMessage = await first
    check(!initMessage.done, 'init 消息应被 yield')

    const second = stream.next()
    double.push({ type: 'assistant', session_id: 'native-1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    check(!(await second).done, 'assistant 消息应被 yield')

    const third = stream.next()
    double.push({
      type: 'result',
      subtype: 'success',
      session_id: 'native-1',
      terminal_reason: 'completed',
      modelUsage: { 'runner-model': { contextWindow: 200_000 } },
    })
    check(!(await third).done, 'result 消息应被 yield')

    const done = await stream.next()
    check(done.done === true, 'terminal result 后 adapter 应主动结束 iterator')
    equal(double.state.returnCalls, 1, 'iterator.return 调用次数')
    equal(sessionIds, ['native-1', 'native-1', 'native-1'], 'session id 回调（每条携带 session_id 的消息都会上报）')
    equal(models, ['runner-model'], '模型确认回调')
    equal(contextWindows, [200_000], '上下文窗口回调')
    check(double.state.options!.includePartialMessages === false, 'SDK 仍需 includePartialMessages: false')
    check(!('toolUseConcurrency' in double.state.options!), '不得传 SDK 不识别的 toolUseConcurrency（会被静默忽略）')
    return '3 条消息按顺序透传；session id / 模型 / 上下文窗口回调齐全；terminal 后主动结束 iterator'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioPermissionCallback(): Promise<string> {
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  const calls: string[] = []
  try {
    const stream = adapter.query(createSession('runner-permission', {
      prepared: {
        canUseTool: async (toolName, input, options) => {
          calls.push(`${toolName}:${options.toolUseID ?? '-'}`)
          return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID, decisionClassification: 'user_temporary' }
        },
      },
    }))[Symbol.asyncIterator]()
    const pending = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    const sdkCanUseTool = double.state.options!.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID?: string },
    ) => Promise<unknown>
    const result = await sdkCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'call-9' })
    equal(result, { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'call-9', decisionClassification: 'user_temporary' }, '权限结果回传')
    equal(calls, ['Bash:call-9'], '宿主权限回调被调用一次')
    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    await pending
    return '宿主 canUseTool 经 SDK options 注入，调用与结果回传一致'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioQueuedMessageAndInterrupt(): Promise<string> {
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  try {
    const stream = adapter.query(createSession('runner-queue'))[Symbol.asyncIterator]()
    const pending = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    const initial = await double.nextPromptInput()
    equal((initial as { message: { content: string } }).message.content, 'runner fixture', '初始 prompt 进入消息通道')

    await adapter.sendQueuedMessage('runner-queue', {
      type: 'user',
      message: { role: 'user', content: 'queued turn' },
      parent_tool_use_id: null,
      session_id: 'runner-queue',
      uuid: 'queued-1',
      priority: 'now',
    })
    const injected = await double.nextPromptInput()
    equal((injected as { message: { content: string } }).message.content, 'queued turn', '队列消息注入通道')

    await adapter.interruptQuery('runner-queue')
    equal(double.state.interruptCalls, 1, 'query.interrupt 调用次数')
    await adapter.setPermissionMode('runner-queue', 'bypassPermissions')
    equal(double.state.permissionModeCalls, ['bypassPermissions'], 'setPermissionMode 透传')

    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    await pending
    return '流式追加消息经长生命周期通道注入，软中断与权限模式切换均透传到 SDK'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioCancel(): Promise<string> {
  const { port, exits } = createFakeClaudeLifecyclePort()
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ processLifecycle: port, sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  try {
    const stream = adapter.query(createSession('runner-cancel'))[Symbol.asyncIterator]()
    const pending = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    const controller = double.state.options!.abortController as AbortController
    const abortedBefore: boolean = controller.signal.aborted
    check(abortedBefore === false, 'abort 前信号不应已中止')

    adapter.abort('runner-cancel')
    const abortedAfter: boolean = controller.signal.aborted
    check(abortedAfter === true, 'abort 后 abortController 信号应中止')
    equal(double.state.closeCalls, 1, 'abort 应关闭 SDK query')
    check((await pending).done === true, 'abort 后迭代流应立即结束')

    let rejected = false
    try {
      await adapter.getTaskOutput('runner-cancel', 'missing')
    } catch {
      rejected = true
    }
    check(rejected, 'abort 后不应再能读取该会话的任务记录')

    adapter.dispose()
    check(exits.includes('runner-cancel'), 'dispose 应通知宿主 onExit')
    return 'abort 关闭 query、中止信号、结束迭代流并清理会话状态'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioError(): Promise<string> {
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  try {
    const stream = adapter.query(createSession('runner-error'))[Symbol.asyncIterator]()
    const first = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    double.push({ type: 'system', subtype: 'init', session_id: 's' })
    check(!(await first).done, 'init 消息应被 yield')

    const failing = stream.next()
    double.fail(new Error('sdk stream boom'))
    let propagated: unknown
    try {
      await failing
    } catch (error) {
      propagated = error
    }
    check(propagated instanceof Error && propagated.message === 'sdk stream boom', 'SDK 流错误应透传')

    // 失败后仍可继续使用同一个 adapter（映射已清理）。
    const second = adapter.query(createSession('runner-error-2'))[Symbol.asyncIterator]()
    const pendingSecond = second.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    check(!(await pendingSecond).done, '错误后 adapter 应可再次发起查询')

    const mapped = mapSDKErrorToTypedError('unknown', 'API Error: 402 Insufficient credit. Add funds at x/billing.', '402')
    equal(mapped.code, 'insufficient_credits', '额度错误映射')
    return 'SDK 流错误透传、失败后可复用；错误映射仍归类为 insufficient_credits'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioTerminalSemantics(): Promise<string> {
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  try {
    const stream = adapter.query(createSession('runner-terminal'))[Symbol.asyncIterator]()
    const pending = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')

    // 软中断类 terminal_reason：保留通道，后续 turn 继续。
    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'aborted_streaming' })
    await pending
    equal(double.state.returnCalls, 0, '可继续的 terminal_reason 不应结束 iterator')
    const followUp = stream.next()
    double.push({ type: 'assistant', session_id: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'next turn' }] } })
    check(!(await followUp).done, '保留通道后应能继续收到消息')

    // Stop hook 观察到后台任务：标记软空闲并保持通道。
    const hooks = double.state.options!.hooks as { Stop: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }
    await hooks.Stop[0]!.hooks[0]!({ background_tasks: [{ task_id: 'bg' }], session_crons: [] })
    const backgroundPending = stream.next()
    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    const annotated = await backgroundPending
    check((annotated.value as Record<string, unknown>)._keepChannelOpenForTasks === true, '后台任务挂起时应标注软空闲')

    // 后台任务结束：下一轮 result 才真正收尾。
    await hooks.Stop[0]!.hooks[0]!({ background_tasks: [], session_crons: [] })
    const finalTurn = stream.next()
    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    await finalTurn
    check((await stream.next()).done === true, '后台任务结束后应结束 iterator')
    equal(double.state.returnCalls, 1, 'iterator.return 调用次数')
    return '可继续 terminal_reason 保留通道；后台任务挂起标注软空闲，任务清空后正常收尾'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioTaskOutputAndStop(): Promise<string> {
  const { port, manager } = createFakeClaudeLifecyclePort()
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ processLifecycle: port, sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  const dir = mkdtempSync(join(tmpdir(), 'runner-claude-task-'))
  try {
    const outputFile = join(dir, 'output.txt')
    writeFileSync(outputFile, 'task output from file')
    const stream = adapter.query(createSession('runner-task'))[Symbol.asyncIterator]()
    const first = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    double.push({ type: 'system', subtype: 'task_started', task_id: 'task', task_type: 'local_bash' })
    await first
    const second = stream.next()
    double.push({ type: 'system', subtype: 'task_progress', task_id: 'task', summary: 'working' })
    await second

    equal(await adapter.getTaskOutput('runner-task', 'task', { block: false }), { output: '', isComplete: false, status: 'running', summary: 'working' }, '运行中任务输出')

    let foreign = false
    try {
      await adapter.stopTask('foreign-session', 'task')
    } catch {
      foreign = true
    }
    check(foreign, '跨会话 stopTask 必须被拒绝')
    let mismatch = false
    try {
      await adapter.stopTask('runner-task', 'task', 'agent')
    } catch {
      mismatch = true
    }
    check(mismatch, '任务类型不匹配必须被拒绝')
    equal(double.state.stopTaskCalls, [], '校验失败时不得调用 SDK stopTask')

    await adapter.stopTask('runner-task', 'task', 'shell')
    equal(double.state.stopTaskCalls, ['task'], 'SDK stopTask 调用')
    equal(manager.get('runner-task', 'task')?.status, 'stopped', '宿主记录状态')

    const third = stream.next()
    double.push({ type: 'system', subtype: 'task_notification', task_id: 'done', status: 'completed', output_file: outputFile, summary: 'finished' })
    await third
    equal(await adapter.getTaskOutput('runner-task', 'done'), { output: 'task output from file', status: 'completed', isComplete: true, summary: 'finished' }, '终态任务输出')
    check(readFileSync(outputFile, 'utf8') === 'task output from file', '输出文件由宿主持有')

    const fourth = stream.next()
    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    await fourth
    return 'task output/stop 走宿主端口：归属与类型校验、SDK stop 委托、文件输出读取均保持'
  } finally {
    adapter.dispose()
    double.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function scenarioProcessDouble(): Promise<string> {
  const { port, spawns } = createFakeClaudeLifecyclePort()
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ processLifecycle: port, sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  const stderrChunks: string[] = []
  try {
    const stream = adapter.query(createSession('runner-spawn', { onStderr: (data) => stderrChunks.push(data) }))[Symbol.asyncIterator]()
    const pending = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    check(typeof double.state.options!.spawnClaudeCodeProcess === 'function', 'adapter 必须向 SDK 传 spawnClaudeCodeProcess')

    const child = double.spawn({ env: { NODE_OPTIONS: '--expose-gc' } }) as FakeChildProcess
    equal(double.state.spawnedEnvs[0]!.NODE_OPTIONS, '--expose-gc --max-old-space-size=4096', 'NODE_OPTIONS 合并堆上限')
    equal(spawns, [{ sessionId: 'runner-spawn', pid: child.pid }], '宿主 onSpawn 收到 PID')
    child.stderr.emit('data', Buffer.from('stderr fixture'))
    equal(stderrChunks, ['stderr fixture'], 'stderr 转发')

    const second = double.spawn({ env: { NODE_OPTIONS: '--max-old-space-size=1024' } }) as FakeChildProcess
    equal(double.state.spawnedEnvs[1]!.NODE_OPTIONS, '--max-old-space-size=1024', '已有堆上限时不重复注入')
    child.exit()
    second.exit()

    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    await pending
    return '进程替身验证：PID 登记、堆上限注入、stderr 转发与退出清理'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioCleanup(): Promise<string> {
  const { port, exits } = createFakeClaudeLifecyclePort()
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({ processLifecycle: port, sdkLoader: async () => double.module, spawnProcess: double.spawnProcess })
  try {
    const stream = adapter.query(createSession('runner-cleanup'))[Symbol.asyncIterator]()
    const pending = stream.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    double.push({ type: 'system', subtype: 'init', session_id: 's' })
    await pending

    adapter.dispose()
    equal(double.state.closeCalls, 1, 'dispose 关闭活跃 query')
    check(exits.includes('runner-cleanup'), 'dispose 通知宿主 onExit')

    const second = adapter.query(createSession('runner-cleanup-2'))[Symbol.asyncIterator]()
    const pendingSecond = second.next()
    await waitUntil(() => double.state.options !== undefined, 2_000, 'SDK options')
    double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
    check(!(await pendingSecond).done, 'dispose 后 adapter 仍可复用')
    return 'dispose 关闭 query、通知宿主 onExit，且实例可继续复用'
  } finally {
    adapter.dispose()
    double.dispose()
  }
}

async function scenarioNoElectronDependency(): Promise<string> {
  const modulePath = new URL('../src/claude-agent-adapter.ts', import.meta.url)
  const source = await Bun.file(modulePath).text()
  const forbidden = [/\bfrom\s+['"][^'"]*apps\/electron[^'"]*['"]/, /import\(\s*['"][^'"]*apps\/electron[^'"]*['"]\s*\)/]
  for (const pattern of forbidden) {
    check(!pattern.test(source), `provider adapter 不得引用 apps/electron（命中 ${pattern}）`)
  }
  return 'provider adapter 源码不含 apps/electron 引用'
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const SCENARIOS: Array<[string, () => Promise<string>]> = [
  ['SDK 流透传与回调（session/model/contextWindow/终态）', scenarioStreamAndCallbacks],
  ['权限回调（宿主 canUseTool 注入与回传）', scenarioPermissionCallback],
  ['流式追加消息与软中断（queued message / interrupt / 权限模式）', scenarioQueuedMessageAndInterrupt],
  ['取消（abort 关闭 query、中止信号、状态清理）', scenarioCancel],
  ['错误（SDK 流错误透传、失败后复用、错误映射）', scenarioError],
  ['终态语义（可继续 terminal_reason 与后台任务挂起）', scenarioTerminalSemantics],
  ['后台任务 output/stop（宿主端口委托与校验）', scenarioTaskOutputAndStop],
  ['进程替身（PID 登记、堆上限、stderr、退出清理）', scenarioProcessDouble],
  ['资源清理（dispose 与复用）', scenarioCleanup],
  ['静态检查（provider 不引用 apps/electron）', scenarioNoElectronDependency],
]

const results: ScenarioResult[] = []
for (const [name, body] of SCENARIOS) {
  const result = await runScenario(name, body)
  results.push(result)
  const mark = result.ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name} (${result.durationMs}ms)`)
  console.log(`        ${result.detail}`)
}

const failed = results.filter((result) => !result.ok)
console.log(`\nminimal-claude-runner: ${results.length - failed.length}/${results.length} 场景通过`)
if (failed.length > 0) {
  console.log('失败场景：')
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`)
  process.exit(1)
}
process.exit(0)
