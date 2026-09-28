import { describe, expect, test } from 'bun:test'
import { GoalController } from './goal-controller'
import { createGoalState } from './goal-loop'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('GoalController', () => {
  test('runs one turn and schedules the next turn after continue', async () => {
    const runs: string[] = []
    const completions = deferred<void>()
    const controller = new GoalController({
      runTurn: async ({ state }) => { runs.push(`run-${state.iteration}`); await completions.promise; return { status: 'continue', summary: '继续', evidence: ['已执行'] } },
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '完成目标')
    expect(runs).toEqual(['run-1'])
    completions.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runs.length).toBeGreaterThan(1)
    await controller.stop('session-1')
    expect(controller.get('session-1')?.status).toBe('stopped')
  })

  test('stop prevents a completed turn from scheduling another turn', async () => {
    const completions = deferred<void>()
    let runCount = 0
    const controller = new GoalController({
      runTurn: async () => { runCount++; await completions.promise; return { status: 'continue', summary: '继续', evidence: ['已执行'] } },
      stopTurn: async () => { completions.resolve() },
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '停止目标')
    await controller.stop('session-1')
    await Promise.resolve()
    expect(runCount).toBe(1)
    expect(controller.get('session-1')?.status).toBe('stopped')
  })

  test('records iteration history and contract on start', async () => {
    const controller = new GoalController({
      runTurn: async () => ({ status: 'complete', summary: '全部完成', evidence: ['测试通过'], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })

    await controller.start('session-1', '完成目标', { verification: '测试通过' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const state = controller.get('session-1')
    expect(state?.status).toBe('completed')
    expect(state?.contract).toEqual({ verification: '测试通过' })
    expect(state?.history).toHaveLength(1)
    expect(state?.history?.[0]).toMatchObject({ iteration: 1, status: 'complete', summary: '全部完成', evidence: ['测试通过'], usage: { totalTokens: 15 } })
    expect(state?.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  test('restore downgrades active goals to paused and lists them', async () => {
    const controller = new GoalController({
      runTurn: async () => ({ status: 'continue', summary: '', evidence: [] }),
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })
    const active = createGoalState('session-1', '长跑目标', 1000)
    const completed = { ...createGoalState('session-2', '已完成目标', 1000), status: 'completed' as const }
    controller.restore([active, completed])
    expect(controller.get('session-1')?.status).toBe('paused')
    expect(controller.get('session-1')?.stopReason).toBe('app_restart')
    expect(controller.get('session-2')?.status).toBe('completed')
    expect(controller.list()).toHaveLength(2)
    // 恢复后的 paused goal 可以显式恢复执行
    const runs: number[] = []
    const controller2 = new GoalController({
      runTurn: async ({ state }) => { runs.push(state.iteration); return { status: 'blocked', summary: '需要用户输入', evidence: [] } },
      stopTurn: async () => {},
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })
    controller2.restore([{ ...active, startedAt: Date.now() }])
    await controller2.resume('session-1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runs.length).toBeGreaterThan(0)
    expect(controller2.get('session-1')?.status).toBe('blocked')
  })

  test('stopAll pauses active goals for process exit instead of dropping them', async () => {
    const completions = deferred<void>()
    const controller = new GoalController({
      runTurn: async () => { await completions.promise; return { status: 'continue', summary: '', evidence: [] } },
      stopTurn: async () => { completions.resolve() },
      onStateChange: () => {},
      schedule: (callback) => { queueMicrotask(callback); return 1 },
      cancelSchedule: () => {},
    })
    await controller.start('session-1', '长跑目标')
    controller.stopAll()
    expect(controller.get('session-1')?.status).toBe('paused')
    expect(controller.get('session-1')?.stopReason).toBe('app_restart')
  })
})
