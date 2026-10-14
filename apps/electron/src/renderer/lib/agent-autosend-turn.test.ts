import { describe, expect, test } from 'bun:test'
import { evaluateAutoSendTurn, shouldStartAutoSendFromIdle } from './agent-autosend-turn'
import type { AutoSendTurnState } from './agent-autosend-turn'
import { applyAgentEvent, type AgentStreamState } from '../atoms/agent-atoms'
import { settleCompletedAgentStreamState } from './agent-stream-state-cleanup'

function baseState(overrides: Partial<AutoSendTurnState> = {}): AutoSendTurnState {
  return {
    turnVersion: 0,
    consumedVersion: 0,
    autoSendEnabled: true,
    queuedCount: 0,
    liveMessagesPending: false,
    streaming: false,
    stoppedByUser: false,
    canSendQueuedNow: true,
    ...overrides,
  }
}

describe('shouldStartAutoSendFromIdle 空闲队列自动启动', () => {
  test('空闲时队列非空且可发送，立即启动队首', () => {
    expect(shouldStartAutoSendFromIdle({
      queuedCount: 1,
      liveMessagesPending: false,
      streaming: false,
      stoppedByUser: false,
      canSendQueuedNow: true,
    })).toBe(true)
  })

  test('运行中、停止态、live 未清空或不可发送时不启动', () => {
    const base = {
      queuedCount: 1,
      liveMessagesPending: false,
      streaming: false,
      stoppedByUser: false,
      canSendQueuedNow: true,
    }
    expect(shouldStartAutoSendFromIdle({ ...base, streaming: true })).toBe(false)
    expect(shouldStartAutoSendFromIdle({ ...base, stoppedByUser: true })).toBe(false)
    expect(shouldStartAutoSendFromIdle({ ...base, liveMessagesPending: true })).toBe(false)
    expect(shouldStartAutoSendFromIdle({ ...base, canSendQueuedNow: false })).toBe(false)
  })
})

describe('evaluateAutoSendTurn 轮结束自动发送决策', () => {
  test('Claude/Pi 共用压缩事件：compact_boundary 之后仍等 STREAM_COMPLETE 才发送', () => {
    const compacting: AgentStreamState = {
      running: true,
      content: '',
      toolActivities: [],
      isCompacting: true,
      compactInFlight: true,
    }
    const boundary = applyAgentEvent(compacting, { type: 'compact_complete' })
    expect(boundary.running).toBe(true)
    expect(boundary.isCompacting).toBe(false)
    expect(boundary.compactInFlight).toBe(true)
    expect(evaluateAutoSendTurn(baseState({ queuedCount: 1, streaming: boundary.running }))).toBe('idle')

    const settled = settleCompletedAgentStreamState(boundary, false)
    expect(settled.compactInFlight).toBe(false)
    expect(evaluateAutoSendTurn(baseState({ queuedCount: 1, streaming: settled.running }))).toBe('send')
  })

  test('自动压缩完成但原任务仍运行时，不发送排队消息', () => {
    const boundary = applyAgentEvent({
      running: true,
      content: '原任务继续',
      toolActivities: [],
    }, { type: 'compact_complete' })
    expect(evaluateAutoSendTurn(baseState({
      queuedCount: 1,
      streaming: boundary.running,
      liveMessagesPending: true,
    }))).toBe('idle')
  })

  test('压缩空队列结束后再入队：不依赖旧轮结束信号也能启动队首', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 0 }))).toBe('consume')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 1, queuedCount: 1 }))).toBe('send')
  })

  test('压缩结束后重新挂载，未捕获 running 下降沿时仍发送空闲队列', () => {
    expect(evaluateAutoSendTurn(baseState({ queuedCount: 2 }))).toBe('send')
  })

  test('压缩后的实时消息完成持久化展示交接前不发送，交接后发送', () => {
    expect(evaluateAutoSendTurn(baseState({ queuedCount: 1, liveMessagesPending: true }))).toBe('idle')
    expect(evaluateAutoSendTurn(baseState({ queuedCount: 1, liveMessagesPending: false }))).toBe('send')
  })

  test('本轮结束时暂不可发送，条件恢复后不需要另一个轮结束信号', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, queuedCount: 1, canSendQueuedNow: false }))).toBe('consume')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 1, queuedCount: 1 }))).toBe('send')
  })

  test('发送成功后释放锁再次判断：本轮结束信号已消费也能继续 FIFO', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 2, consumedVersion: 2, queuedCount: 1 }))).toBe('send')
  })

  test('正常发送：轮结束 + 队列非空 + 可发送 → send', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1 }))).toBe('send')
  })

  test('运行中开启后等待当前轮结束，不向活跃 run 抢发', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 3, consumedVersion: 3, queuedCount: 1, streaming: true }))).toBe('idle')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 4, consumedVersion: 3, queuedCount: 1 }))).toBe('send')
  })

  test('live 未清空：等待上轮执行进入 persisted，不消费版本号 → defer', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, liveMessagesPending: true }))).toBe('defer')
  })

  test('streaming / stoppedByUser / 不可发送：发送机会已过，消费版本号 → consume', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, streaming: true }))).toBe('consume')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, stoppedByUser: true }))).toBe('consume')
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 0, queuedCount: 1, canSendQueuedNow: false }))).toBe('consume')
  })

  test('关闭自动发送时优先消费当前轮结束信号，空闲队列也不发送', () => {
    expect(evaluateAutoSendTurn(baseState({
      turnVersion: 1,
      consumedVersion: 1,
      autoSendEnabled: false,
      queuedCount: 1,
      liveMessagesPending: true,
    }))).toBe('consume')
    expect(evaluateAutoSendTurn(baseState({ autoSendEnabled: false, queuedCount: 1 }))).toBe('consume')
  })

  test('用户停止或压缩/停止尚未释放时，空闲队列也不发送', () => {
    expect(evaluateAutoSendTurn(baseState({ queuedCount: 1, stoppedByUser: true }))).toBe('idle')
    expect(evaluateAutoSendTurn(baseState({ queuedCount: 1, canSendQueuedNow: false }))).toBe('idle')
  })

  test('无未消费版本且空队列 → idle', () => {
    expect(evaluateAutoSendTurn(baseState({ turnVersion: 1, consumedVersion: 1 }))).toBe('idle')
    expect(evaluateAutoSendTurn(baseState())).toBe('idle')
  })
})
