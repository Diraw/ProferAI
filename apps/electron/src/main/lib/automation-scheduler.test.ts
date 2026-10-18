import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { normalizeAgentRuntime, AUTOMATION_DEFAULT_SESSION_MODE, AUTOMATION_MAX_CONSECUTIVE_FAILURES, type AgentRuntime, type AgentSessionMeta, type AgentSendInput, type Automation, type AutomationRun } from '@profer/shared'

// 真实调度函数配受控 headless/存储边界；不启动调度器、不连接模型或发送通知。
const source = readFileSync(new URL('./automation-scheduler.ts', import.meta.url), 'utf8')
const start = source.indexOf('export async function runAutomation(')
const body = source.slice(start, source.indexOf('/** 立即运行一次', start)).replace('export ', '')
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
function fixture(runtime: AgentRuntime, taskRuntime: AgentRuntime, mode: 'reuse' | 'daily', graduated = false, blocked?: unknown) {
  const original: AgentSessionMeta = { id: 'old', title: 'old history', createdAt: 1, updatedAt: 2, agentRuntime: runtime, sdkSessionId: 'native-old', piSessionFile: runtime === 'pi' ? '/old.jsonl' : undefined, agentRuntimeLocked: true, automationGraduated: graduated }
  const sessions = new Map<string, AgentSessionMeta>([['old', original]])
  const updates: Array<{ id: string; patch: Partial<AgentSessionMeta> }> = []
  const inputs: AgentSendInput[] = []
  const runtimeInputs: AgentSendInput[] = []
  const runs: AutomationRun[] = []
  const lastIds: string[] = []
  const notifications: AutomationRun[] = []
  const deps = {
    normalizeAgentRuntime, AUTOMATION_DEFAULT_SESSION_MODE, AUTOMATION_MAX_CONSECUTIVE_FAILURES,
    runningAutomations: new Set<string>(), RUN_TIMEOUT_MS: 10000, DAILY_CONTEXT_ROLLOVER_THRESHOLD: 0.7,
    isSameLocalDay: () => true, getSessionContextUsageRatio: () => 0.2,
    getAgentSessionMeta: (id: string) => sessions.get(id), getAgentWorkspace: () => ({ slug: 'workspace' }),
    getAgentWorkspacePath: () => '/tmp/fixture-workspace',
    getDefaultPresetId: () => 'standard', resolvePresetId: (_slug: string, preset: string) => preset,
    createAgentSession: (title: string, channelId: string, workspaceId: string, modelId: string, runtime: AgentRuntime) => {
      const session: AgentSessionMeta = { id: 'new', title, channelId, workspaceId, modelId, agentRuntime: runtime, agentRuntimeLocked: false, createdAt: 3, updatedAt: 3 }
      sessions.set(session.id, session); return session
    },
    updateAgentSessionMeta: (id: string, patch: Partial<AgentSessionMeta>) => { updates.push({ id, patch }); sessions.set(id, { ...sessions.get(id)!, ...patch }) },
    setLastSessionId: (_id: string, sessionId: string) => lastIds.push(sessionId),
    getAutomation: () => undefined, updateAutomation() {}, broadcastChanged() {},
    appendRun: (_id: string, run: AutomationRun) => runs.push(run),
    notifyAutomationRunFinished: async ({ run }: { run: AutomationRun }) => { notifications.push(run) },
    formatScheduleLabel: () => 'fixture',
    runAgentHeadless: async (input: AgentSendInput, callbacks: { onComplete: () => void }) => { inputs.push(input); callbacks.onComplete() },
    runAgentRuntimeHeadless: async (input: AgentSendInput, callbacks: { onComplete: () => void }) => { runtimeInputs.push(input); callbacks.onComplete() },
    // runtime 分支的预检依赖：默认返回 undefined（无阻塞）；用例可注入阻塞原因。
    peekAgentRunClaimFailureForSession: () => blocked,
    describeAgentRunRejection: () => 'fixture rejection',
    setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
  }
  const run = new Function(...Object.keys(deps), `${transpiler.transformSync(body)}\nreturn runAutomation`)(...Object.values(deps)) as (input: Automation) => Promise<void>
  const task = { id: 'task', name: 'task', prompt: 'work', channelId: 'channel', workspaceId: 'workspace', modelId: 'model', lastSessionId: 'old', lastRunAt: Date.now(), sessionMode: mode, agentRuntime: taskRuntime } as Automation
  return { run: () => run(task), sessions, original, updates, inputs, runtimeInputs, runs, notifications, lastIds }
}

describe('定时任务复用会话遵守内核归属', () => {
  for (const mode of ['reuse', 'daily'] as const) {
    test.each(['pi', 'claude'] as const)(`${mode}: %s 任务更换内核时新建会话，旧恢复字段原样保留`, async (runtime) => {
      const f = fixture(runtime, runtime === 'pi' ? 'claude' : 'pi', mode)
      await f.run()
      expect(f.inputs).toHaveLength(1)
      expect(f.inputs[0]?.sessionId).toBe('new')
      expect(f.inputs[0]?.agentRuntime).not.toBe(runtime)
      expect(f.lastIds).toEqual(['new'])
      expect(f.sessions.get('old')).toEqual(f.original)
      expect(f.updates.some((update) => update.id === 'old')).toBe(false)
      expect(f.runs[0]).toMatchObject({ status: 'success', sessionId: 'new' })
    })
    test.each(['pi', 'claude'] as const)(`${mode}: %s 相同内核复用旧会话，不丢上下文`, async (runtime) => {
      const f = fixture(runtime, runtime, mode)
      await f.run()
      expect(f.inputs[0]).toMatchObject({ sessionId: 'old', agentRuntime: runtime })
      expect(f.lastIds).toEqual([])
      expect(f.sessions.get('old')).toEqual(f.original)
      expect(f.updates).toEqual([])
    })
  }
  test('被用户接管的会话即使内核相同也不复用', async () => {
    const f = fixture('pi', 'pi', 'reuse', true)
    await f.run()
    expect(f.inputs[0]?.sessionId).toBe('new')
    expect(f.sessions.get('old')).toEqual(f.original)
  })
})

describe('runtime coordinator automation opt-in', () => {
  test('Given the default scheduler When running automation Then legacy headless path remains the default and runtime switch is explicit', () => {
    expect(source).toContain("process.env.PROFER_RUNTIME_AUTOMATION === '1'")
    expect(source).toContain('runAgentRuntimeHeadless(')
    expect(source).toContain('runAgentHeadless(headlessInput, callbacks)')
    expect(source).toContain('automationContext:')
  })
})

/** 打开 runtime 分支的开关，跑完恢复（避免污染其它测试文件）。 */
async function withRuntimeAutomation<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.PROFER_RUNTIME_AUTOMATION
  process.env.PROFER_RUNTIME_AUTOMATION = '1'
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.PROFER_RUNTIME_AUTOMATION
    else process.env.PROFER_RUNTIME_AUTOMATION = previous
  }
}

describe('AutomationRun 字段语义：新分支与旧分支不漂移', () => {
  test('成功一轮：两侧都只写 {status:success, durationMs}，且通知收到同一份 run', async () => {
    const legacy = fixture('claude', 'claude', 'reuse')
    await legacy.run()
    const runtime = await withRuntimeAutomation(async () => {
      const f = fixture('claude', 'claude', 'reuse')
      await f.run()
      return f
    })

    for (const f of [legacy, runtime]) {
      expect(f.runs).toHaveLength(1)
      const run = f.runs[0]!
      expect(run.status).toBe('success')
      expect(typeof run.durationMs).toBe('number')
      // finish() 统一构造 `{ runAt, sessionId, status, durationMs, error }`：成功时 error 为 undefined
      // （JSON 落盘时被丢弃），两侧一致。
      expect(run.error).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(run, 'skipReason')).toBe(false)
      expect(f.notifications).toEqual([run])
    }
    // 新分支确实走的是 runtime 入口（不是旧入口）
    expect(runtime.runtimeInputs).toHaveLength(1)
    expect(runtime.inputs).toHaveLength(0)
    expect(legacy.inputs).toHaveLength(1)
    expect(legacy.runtimeInputs).toHaveLength(0)
  })

  test('未取得执行权：记 skipped + skipReason，不写失败运行、不启动 run、不发完成通知', async () => {
    await withRuntimeAutomation(async () => {
      const f = fixture('claude', 'claude', 'reuse', false, { reason: 'session_busy' })
      await f.run()

      expect(f.runs).toHaveLength(1)
      const run = f.runs[0]!
      expect(run.status).toBe('skipped')
      expect(run.skipReason).toBe('fixture rejection')
      expect(Object.prototype.hasOwnProperty.call(run, 'error')).toBe(false)
      // 没有 run 就没有 durationMs（finish 从未被调用）
      expect(run.durationMs).toBeUndefined()
      expect(f.runtimeInputs).toHaveLength(0)
      expect(f.inputs).toHaveLength(0)
      // 不把跳过当失败上报：不发完成通知
      expect(f.notifications).toEqual([])
    })
  })

  test('预检为阻塞时旧分支保持既有行为（不看预检）——记录差异，不假装两侧一致', async () => {
    // 旧分支只在开关关闭时使用；此处开关关闭，注入的阻塞不得影响旧分支。
    const f = fixture('claude', 'claude', 'reuse', false, { reason: 'session_busy' })
    await f.run()
    expect(f.runs[0]!.status).toBe('success')
    expect(f.inputs).toHaveLength(1)
  })

  test('源码核对：两侧共用同一组 callbacks，skipped 分支在 run 之前提前返回', () => {
    // 同一组 callbacks ⇒ 终态字段集不随入口漂移（onError → error / onComplete → success）。
    expect(source).toContain('const callbacks = {')
    expect(source).toContain("onError: (error: string) => finish('error', error)")
    expect(source).toContain("onComplete: () => finish('success')")
    expect(source).toContain('runAgentRuntimeHeadless(\n            headlessInput,\n            callbacks,')
    expect(source).toContain('runAgentHeadless(headlessInput, callbacks)')
    // skipped 分支：写 skipped 后 resolveRun() 提前返回，不经过 finish（因此不写失败运行）。
    const skipped = source.slice(
      source.indexOf('if (automationBlocked) {'),
      source.indexOf('// 新旧两条分支共用同一组 callbacks'),
    )
    expect(skipped).toContain("status: 'skipped'")
    expect(skipped).toContain('resolveRun()')
    expect(skipped).not.toContain('finish(')
  })

  test('字段集核对：AutomationRun 只有 status/durationMs/error/skipReason，没有 endReason 系列', () => {
    const sharedSource = readFileSync(new URL('../../../../../packages/shared/src/types/automation.ts', import.meta.url), 'utf8')
    const runInterface = sharedSource.slice(
      sharedSource.indexOf('export interface AutomationRun {'),
      sharedSource.indexOf('/** 调度模式 */'),
    )
    expect(runInterface).toContain("status: 'success' | 'error' | 'skipped'")
    expect(runInterface).toContain('durationMs?')
    expect(runInterface).toContain('error?')
    expect(runInterface).toContain('skipReason?')
    // endReason / endReasonLabel / resultErrors 属于 run_completed 事件（渲染层 toast），不属于运行记录。
    expect(runInterface).not.toContain('endReason')
    expect(runInterface).not.toContain('resultErrors')
  })

  test('连续失败退避：只有 error 累加，skipped/success 清零（appendRun 源码核对）', () => {
    const managerSource = readFileSync(new URL('./automation-manager.ts', import.meta.url), 'utf8')
    const appendRun = managerSource.slice(
      managerSource.indexOf('export function appendRun('),
      managerSource.indexOf('/** 设置 nextRunAt'),
    )
    expect(appendRun).toContain("if (run.status === 'error') {")
    expect(appendRun).toContain('target.consecutiveFailures = (target.consecutiveFailures ?? 0) + 1')
    // skipped 不推进 nextRunAt / runCount（否则重入跳过会把周期拉长）
    expect(appendRun).toContain("if (run.status !== 'skipped') {")
  })
})
