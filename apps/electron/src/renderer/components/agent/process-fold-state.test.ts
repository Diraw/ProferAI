import { describe, expect, test } from 'bun:test'
import { shouldRestartProcessCollapse } from './process-fold-state'

describe('过程折叠生命周期', () => {
  test('输出中断后恢复时撤销已调度的旧自动折叠', () => {
    expect(shouldRestartProcessCollapse({ active: true, collapseScheduled: true, collapseDone: false })).toBe(true)
  })

  test('已收起的历史过程在新一轮输出时重新打开', () => {
    expect(shouldRestartProcessCollapse({ active: true, collapseScheduled: false, collapseDone: true })).toBe(true)
  })

  test('非流式状态不撤销完成态', () => {
    expect(shouldRestartProcessCollapse({ active: false, collapseScheduled: true, collapseDone: false })).toBe(false)
    expect(shouldRestartProcessCollapse({ active: false, collapseScheduled: false, collapseDone: true })).toBe(false)
  })
})
