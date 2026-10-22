import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveAgentRuntimeDisplay, type AgentRuntimeDisplayFacts } from '@/domains/agent-runtime/agent-runtime-display-policy'
import { AgentRuntimeStatus } from './AgentRuntimeStatus'

const render = (facts: AgentRuntimeDisplayFacts) => renderToStaticMarkup(<AgentRuntimeStatus display={deriveAgentRuntimeDisplay(facts)} />)

describe('Agent 活跃状态行渲染', () => {
  test('停止和输出异常仍显示活跃状态，不报告完成', () => {
    for (const facts of [{ running: true, stopping: true }, { running: true, streamError: '断流' }]) {
      const html = render(facts)
      expect(html).toContain('role="status"')
      expect(html).toContain('data-runtime-status=')
      expect(html).not.toContain('已完成')
      expect(html).not.toContain('Agent Running')
    }
  })
  test('后台与协作组合只渲染一条状态行，文案可折行', () => {
    const html = render({ running: false, backgroundWaiting: true, runningDelegationCount: 999 })
    expect(html.match(/data-runtime-status="[^"]+"/g)).toHaveLength(1)
    expect(html).toContain('999 个协作子会话')
    expect(html).toContain('min-w-0')
    expect(html).toContain('break-words')
    expect(html).not.toContain('自动继续')
  })
  test('正常运行和压缩不额外生成状态行，终态不保留旧错误行', () => {
    expect(render({ running: true })).toBe('')
    expect(render({ running: true, compactInFlight: true })).toBe('')
    expect(render({ running: false, streamError: '旧错误' })).toBe('')
  })
})
