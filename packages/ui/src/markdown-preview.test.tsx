import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownPreview, MARKDOWN_PREVIEW_LIGHT_COMPONENTS } from './markdown-preview'

describe('MarkdownPreview 迁移兼容性', () => {
  test('默认不增加容器，保留标题与段落的直接子元素关系', () => {
    const html = renderToStaticMarkup(<MarkdownPreview>{'# 标题\n\n正文'}</MarkdownPreview>)
    expect(html).toBe('<h1>标题</h1>\n<p>正文</p>')
  })

  test('显式 className 仍可提供样式容器', () => {
    const html = renderToStaticMarkup(<MarkdownPreview className="preview">正文</MarkdownPreview>)
    expect(html).toBe('<div class="preview"><p>正文</p></div>')
  })

  test('迷你地图预览保留代码样式，不加载图片或生成可点击链接', () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview components={MARKDOWN_PREVIEW_LIGHT_COMPONENTS}>
        {'`code` [链接](https://example.com) ![图片](https://example.com/a.png)'}
      </MarkdownPreview>,
    )
    expect(html).toContain('text-[11px] bg-muted/50 px-0.5 rounded')
    expect(html).toContain('<span>链接</span>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a ')
  })
})
