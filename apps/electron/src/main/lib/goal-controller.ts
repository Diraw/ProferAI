import {
  createGoalState,
  DEFAULT_GOAL_LIMITS,
  evaluateGoalContinuation,
  GOAL_HISTORY_LIMIT,
  pauseGoalForProcessExit,
} from './goal-loop'
import type { AgentGoalContract, AgentGoalIterationRecord, AgentGoalIterationResult, AgentGoalState } from '@profer/shared'

type TimerHandle = unknown

type GoalControllerDependencies = {
  runTurn: (input: { sessionId: string; state: AgentGoalState; previousSummary?: string }) => Promise<AgentGoalIterationResult>
  stopTurn: (sessionId: string) => Promise<void>
  onStateChange?: (state: AgentGoalState) => void
  schedule?: (callback: () => void) => TimerHandle
  cancelSchedule?: (handle: TimerHandle) => void
}

type Runtime = {
  state: AgentGoalState
  schedule?: TimerHandle
  stopping: boolean
}

export class GoalController {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly schedule: (callback: () => void) => TimerHandle
  private readonly cancelSchedule: (handle: TimerHandle) => void

  constructor(private readonly deps: GoalControllerDependencies) {
    this.schedule = deps.schedule ?? ((callback) => setTimeout(callback, 0))
    this.cancelSchedule = deps.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get(sessionId: string): AgentGoalState | undefined {
    return this.runtimes.get(sessionId)?.state
  }

  list(): AgentGoalState[] {
    return [...this.runtimes.values()].map((runtime) => runtime.state)
  }

  /**
   * 从持久化状态恢复 Goal（重启后不自动续跑：active 一律降级为 paused，
   * 由用户显式 resume，符合「持久目标仍需用户掌控」的边界）。
   */
  restore(states: AgentGoalState[]): void {
    for (const state of states) {
      if (this.runtimes.has(state.sessionId)) continue
      const restored = state.status === 'active'
        ? { ...state, status: 'paused' as const, stopReason: 'app_restart', updatedAt: Date.now() }
        : state
      this.runtimes.set(state.sessionId, { state: restored, stopping: true })
      this.emit(restored)
    }
  }

  async start(sessionId: string, goal: string, contract?: AgentGoalContract, now = Date.now()): Promise<AgentGoalState> {
    if (this.runtimes.has(sessionId)) throw new Error('该会话已有正在运行的 Goal')
    const runtime: Runtime = { state: createGoalState(sessionId, goal, now, DEFAULT_GOAL_LIMITS, contract), stopping: false }
    this.runtimes.set(sessionId, runtime)
    this.emit(runtime.state)
    this.scheduleNext(sessionId, runtime, 0)
    return runtime.state
  }

  async pause(sessionId: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    runtime.stopping = true
    this.cancelPending(runtime)
    await this.deps.stopTurn(sessionId)
    runtime.state = { ...runtime.state, status: 'paused', updatedAt: Date.now() }
    this.emit(runtime.state)
    return runtime.state
  }

  async resume(sessionId: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    if (runtime.state.status !== 'paused') throw new Error('只有暂停中的 Goal 才能恢复')
    runtime.stopping = false
    runtime.state = { ...runtime.state, status: 'active', stopReason: undefined, updatedAt: Date.now() }
    this.emit(runtime.state)
    this.scheduleNext(sessionId, runtime, 0)
    return runtime.state
  }

  async stop(sessionId: string): Promise<AgentGoalState> {
    const runtime = this.require(sessionId)
    runtime.stopping = true
    this.cancelPending(runtime)
    await this.deps.stopTurn(sessionId)
    runtime.state = { ...runtime.state, status: 'stopped', stopReason: 'user', updatedAt: Date.now() }
    this.emit(runtime.state)
    return runtime.state
  }

  /** 更新 Goal 的可由主进程维护的字段（如 blocked 时关联的规划中心 Todo）。 */
  patch(sessionId: string, patch: Partial<Pick<AgentGoalState, 'blockedTodoId'>>): AgentGoalState {
    const runtime = this.require(sessionId)
    runtime.state = { ...runtime.state, ...patch, updatedAt: Date.now() }
    this.emit(runtime.state)
    return runtime.state
  }

  clear(sessionId: string): void {
    const runtime = this.require(sessionId)
    if (runtime.state.status === 'active') throw new Error('运行中的 Goal 不能直接清除')
    this.cancelPending(runtime)
    this.runtimes.delete(sessionId)
    this.deps.onStateChange?.({ ...runtime.state, status: 'stopped', stopReason: 'cleared', updatedAt: Date.now() })
  }

  /**
   * 应用进程退出：不再丢弃 Goal，而是停止当前 turn 并标记为 paused(app_restart)，
   * 配合持久化让 Goal 在下次启动后以「待恢复」姿态可见。
   */
  stopAll(): void {
    for (const [sessionId, runtime] of this.runtimes) {
      runtime.stopping = true
      this.cancelPending(runtime)
      if (runtime.state.status === 'active') {
        runtime.state = pauseGoalForProcessExit(runtime.state)
        this.emit(runtime.state)
        void this.deps.stopTurn(sessionId)
      }
    }
  }

  private require(sessionId: string): Runtime {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) throw new Error('当前会话没有 Goal')
    return runtime
  }

  private cancelPending(runtime: Runtime): void {
    if (runtime.schedule !== undefined) {
      this.cancelSchedule(runtime.schedule)
      runtime.schedule = undefined
    }
  }

  private scheduleNext(sessionId: string, runtime: Runtime, delay: number): void {
    runtime.schedule = this.schedule(() => {
      runtime.schedule = undefined
      void this.runTurn(sessionId, runtime)
    })
    if (delay > 0) {
      // 默认调度器已经是异步的；自定义测试调度器无需额外等待。
    }
  }

  private async runTurn(sessionId: string, runtime: Runtime): Promise<void> {
    if (runtime.stopping || runtime.state.status !== 'active') return
    const iteration = runtime.state.iteration + 1
    runtime.state = { ...runtime.state, iteration, updatedAt: Date.now() }
    this.emit(runtime.state)
    const turnStartedAt = Date.now()
    try {
      const result = await this.deps.runTurn({ sessionId, state: runtime.state, previousSummary: runtime.state.lastSummary })
      if (runtime.stopping || runtime.state.status !== 'active') return
      const decision = evaluateGoalContinuation(result, {
        iteration,
        consecutiveFailures: runtime.state.consecutiveFailures,
        startedAt: runtime.state.startedAt,
        now: Date.now(),
        limits: runtime.state.limits,
      })
      const nextStatus = decision.action === 'continue' ? 'active' : decision.action === 'complete' ? 'completed' : decision.action === 'blocked' ? 'blocked' : decision.action === 'failed' ? 'failed' : 'paused'
      const record: AgentGoalIterationRecord = {
        iteration,
        startedAt: turnStartedAt,
        finishedAt: Date.now(),
        status: result.status,
        summary: result.summary,
        evidence: result.evidence,
        usage: result.usage,
      }
      const usage = result.usage
        ? {
            inputTokens: (runtime.state.usage?.inputTokens ?? 0) + result.usage.inputTokens,
            outputTokens: (runtime.state.usage?.outputTokens ?? 0) + result.usage.outputTokens,
            totalTokens: (runtime.state.usage?.totalTokens ?? 0) + result.usage.totalTokens,
          }
        : runtime.state.usage
      runtime.state = {
        ...runtime.state,
        status: nextStatus,
        consecutiveFailures: decision.consecutiveFailures,
        history: [...(runtime.state.history ?? []), record].slice(-GOAL_HISTORY_LIMIT),
        usage,
        lastSummary: result.summary,
        lastEvidence: result.evidence,
        stopReason: 'reason' in decision ? decision.reason : undefined,
        updatedAt: Date.now(),
      }
      this.emit(runtime.state)
      if (decision.action === 'continue') this.scheduleNext(sessionId, runtime, 0)
    } catch (error) {
      if (runtime.stopping) return
      runtime.state = { ...runtime.state, status: 'failed', stopReason: error instanceof Error ? error.message : 'Goal 执行失败', updatedAt: Date.now() }
      this.emit(runtime.state)
    }
  }

  private emit(state: AgentGoalState): void {
    this.deps.onStateChange?.(state)
  }
}
