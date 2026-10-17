/**
 * 会话内可视化的**外框结构守卫**。
 *
 * 可视化是会话流里的独立对象，不是回复正文的延续，所以它必须自带边界：外框沿用代码块 /
 * Mermaid 的「描边 + 34px 头部栏」，标题、导出入口、内容区、引用条全部落在框内。
 * 这里用静态渲染钉住这层结构——外框一旦被拆掉，视觉上就退化成「一段没有归属的 HTML」，
 * 而这类退化不会有任何类型错误或运行时报错来提醒。
 */
import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { VisualizationRecord } from '@profer/shared'
import { VisualizationResultInline } from './InlineVisualization'

const record: VisualizationRecord = {
  schemaVersion: 1,
  id: 'viz-1',
  sessionId: 'session-1',
  toolCallId: 'call-1',
  title: '季度收入对比',
  kind: 'data',
  format: 'fragment',
  revision: 'rev-1',
  recordVersion: 1,
  summary: '四个季度的收入与成本对比。',
  objects: [],
  createdAt: 1,
  updatedAt: 1,
}

function render(overrides: Partial<VisualizationRecord> = {}): string {
  const store = createStore()
  return renderToStaticMarkup(
    <Provider store={store}>
      <VisualizationResultInline record={{ ...record, ...overrides }} sessionId="session-1" />
    </Provider>,
  )
}

describe('会话内可视化外框', () => {
  test('结果被包在一层描边容器里，头部栏带标题与导出入口', () => {
    const html = render()
    expect(html).toContain('rounded-lg border border-border')
    expect(html).toContain('bg-muted/60')
    expect(html).toContain('季度收入对比')
    expect(html).toContain('aria-label="导出 HTML"')
  })

  test('头部栏与内容区都在框内，不在框外另起一块', () => {
    const html = render()
    const frame = html.indexOf('border-border')
    const header = html.indexOf('bg-muted/60')
    const body = html.indexOf('正在加载交互视图')
    expect(frame).toBeGreaterThan(-1)
    expect(header).toBeGreaterThan(frame)
    expect(body).toBeGreaterThan(header)
    // 内容区自己垫一层 muted 底：浅色主题下 --muted 与白底几乎同色，靠它把“画布”从正文里分出来
    expect(html).toContain('bg-muted/20 p-3')
  })

  test('chart 结果的头部栏显示「图表」', () => {
    const html = render({
      format: 'chart',
      chart: { chartType: 'bar', xKey: 'quarter', series: [{ dataKey: 'revenue' }], data: [{ quarter: 'Q1', revenue: 12 }] },
    })
    expect(html).toContain('>图表<')
  })

  test('加载与报错态同样落在框内（失败也保有边界）', () => {
    const html = render({ format: 'html', chart: undefined })
    expect(html).toContain('四个季度的收入与成本对比。')
    expect(html.indexOf('四个季度的收入与成本对比。')).toBeGreaterThan(html.indexOf('border-border'))
  })
})
