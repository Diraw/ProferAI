import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  resolveDelegationRuntimeDisplay,
  type DelegationRuntimeDisplayInput,
} from '@/domains/agent-runtime/delegation-runtime-display'
import { DelegationRuntimeBar } from './DelegationRuntimeBar'

const NOW = 1_800_000_000_000

const base: DelegationRuntimeDisplayInput = {
  parentSessionId: 'parent',
  sourceDelegationId: 'delegation',
  delegationStatus: 'running',
  liveRunning: true,
  liveStartedAt: NOW - 12_000,
  sessionUpdatedAt: NOW - 1_000,
  now: NOW,
}

const render = (input: DelegationRuntimeDisplayInput): string =>
  renderToStaticMarkup(<DelegationRuntimeBar display={resolveDelegationRuntimeDisplay(input)} />)

describe('委派子会话状态条渲染', () => {
  test('Given 运行中 When 渲染 Then 显示运行文案、转圈与计时', () => {
    const html = render(base)
    expect(html).toContain('data-delegation-runtime="running"')
    expect(html).toContain('子代理运行中')
    expect(html).toContain('data-delegation-elapsed=')
  })

  test('Given 持久化 running 但无实时状态 When 渲染 Then 仍报运行中，有回退起点时照常计时', () => {
    const noStart = render({ ...base, liveRunning: false, liveStartedAt: undefined })
    expect(noStart).toContain('data-delegation-runtime="running"')
    expect(noStart).toContain('data-delegation-runtime-live="false"')
    expect(noStart).not.toContain('data-delegation-elapsed=')

    const withFallback = render({
      ...base,
      liveRunning: false,
      liveStartedAt: undefined,
      fallbackStartedAt: NOW - 30_000,
    })
    expect(withFallback).toContain('data-delegation-elapsed=')
  })

  test('Given 已完成 When 渲染 Then 只有状态文案，不再显示运行计时', () => {
    const html = render({ ...base, liveRunning: false, liveStartedAt: undefined, delegationStatus: 'completed' })
    expect(html).toContain('data-delegation-runtime="completed"')
    expect(html).toContain('子代理已完成')
    expect(html).not.toContain('data-delegation-elapsed=')
  })

  test('Given 普通会话 When 渲染 Then 不产出任何节点', () => {
    expect(render({ ...base, parentSessionId: undefined })).toBe('')
    expect(render({ ...base, delegationStatus: null, liveRunning: false })).toBe('')
  })
})
