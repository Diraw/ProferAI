import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { AgentRuntimeSelector } from './AgentRuntimeSelector'

function render(runtime: 'pi' | 'claude', locked: boolean, disabled = false) {
  return renderToStaticMarkup(<TooltipProvider><AgentRuntimeSelector runtime={runtime} locked={locked} disabled={disabled} onChange={() => { throw new Error('SSR 不应改变内核') }} /></TooltipProvider>)
}

describe('会话内核选择器', () => {
  test.each(['pi', 'claude'] as const)('%s 已绑定会话保留内核标签且禁用切换', (runtime) => {
    const html = render(runtime, true)
    expect(html).toContain(`Agent 内核：${runtime === 'pi' ? 'Pi' : 'Claude'}`)
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('aria-expanded="true"')
  })
  test('空会话允许选择；请求保存或开始运行时禁用', () => {
    expect(render('pi', false)).not.toContain('disabled=""')
    expect(render('pi', false, true)).toContain('disabled=""')
  })
})
