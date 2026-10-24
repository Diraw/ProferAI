import { describe, expect, test } from 'bun:test'
import {
  DELEGATION_RUNNING_STALE_MS,
  formatDelegationElapsed,
  resolveDelegationRuntimeDisplay,
} from './delegation-runtime-display'

const NOW = 1_800_000_000_000

const base = {
  parentSessionId: 'parent',
  sourceDelegationId: 'delegation',
  sessionUpdatedAt: NOW - 1_000,
  now: NOW,
}

describe('委派子会话运行状态显示', () => {
  test('Given 普通会话或探索分支 When 解析 Then 不显示状态条', () => {
    expect(resolveDelegationRuntimeDisplay({ ...base, parentSessionId: undefined, liveRunning: true }).visible).toBe(false)
    expect(resolveDelegationRuntimeDisplay({ ...base, sourceDelegationId: undefined, liveRunning: true }).visible).toBe(false)
  })

  test('Given 实时流在运行 When 解析 Then 用实时起点驱动计时', () => {
    const display = resolveDelegationRuntimeDisplay({
      ...base,
      liveRunning: true,
      liveStartedAt: NOW - 65_000,
      delegationStatus: 'running',
    })
    expect(display).toMatchObject({ visible: true, phase: 'running', live: true, startedAt: NOW - 65_000 })
  })

  test('Given 持久化 running 但无实时状态 When 解析 Then 无回退起点时不臆造计时起点', () => {
    const display = resolveDelegationRuntimeDisplay({ ...base, liveRunning: false, delegationStatus: 'running' })
    expect(display).toMatchObject({ visible: true, phase: 'running', live: false })
    expect(display.startedAt).toBeUndefined()
  })

  test('Given 持久化 running 但无实时状态 When 解析 Then 用最近一条人类输入作为本轮起点', () => {
    const display = resolveDelegationRuntimeDisplay({
      ...base,
      liveRunning: false,
      delegationStatus: 'running',
      fallbackStartedAt: NOW - 30_000,
    })
    expect(display).toMatchObject({ visible: true, phase: 'running', live: false, startedAt: NOW - 30_000 })
  })

  test('Given 持久化 running 但长期无活动 When 解析 Then 不再伪装成运行中', () => {
    const display = resolveDelegationRuntimeDisplay({
      ...base,
      liveRunning: false,
      delegationStatus: 'running',
      sessionUpdatedAt: NOW - DELEGATION_RUNNING_STALE_MS - 1,
    })
    expect(display).toMatchObject({ visible: true, phase: 'unknown', live: false })
    expect(display.startedAt).toBeUndefined()
  })

  test('Given 终态 When 解析 Then 显示状态但不再给运行计时', () => {
    for (const [status, label] of [
      ['completed', '子代理已完成'],
      ['failed', '子代理执行失败'],
      ['cancelled', '子代理已取消'],
      ['interrupted', '子代理已中断'],
    ] as const) {
      const display = resolveDelegationRuntimeDisplay({ ...base, liveRunning: false, delegationStatus: status })
      expect(display).toMatchObject({ visible: true, phase: status, label, live: false })
      expect(display.startedAt).toBeUndefined()
    }
  })

  test('Given 未知状态 When 解析 Then 不显示（不把普通子会话当成委派态）', () => {
    expect(resolveDelegationRuntimeDisplay({ ...base, liveRunning: false, delegationStatus: null }).visible).toBe(false)
  })

  test('耗时格式：一分钟内按秒，此后按 分:秒', () => {
    expect(formatDelegationElapsed(9_400)).toBe('9s')
    expect(formatDelegationElapsed(65_000)).toBe('1:05')
    expect(formatDelegationElapsed(-1)).toBe('0s')
  })
})
