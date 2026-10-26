import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { PreviewTabContent } from './PreviewTabContent'

describe('PreviewTabContent 关闭入口', () => {
  test('预览元数据缺失时顶栏仍提供关闭预览按钮', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <TooltipProvider>
          <PreviewTabContent tabId="__preview__:s:/tmp/a.css" sessionId="s" filePath="/tmp/a.css" />
        </TooltipProvider>
      </Provider>,
    )
    expect(html).toContain('预览状态已失效')
    expect(html).toContain('aria-label="关闭预览"')
  })
})
