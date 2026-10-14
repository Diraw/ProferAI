import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

type MarkdownComponentProps = React.ComponentProps<typeof Markdown>

/**
 * 轻量 Markdown 预览的共享标签渲染：小号等宽代码、隐藏图片、链接纯文本。
 * 供迷你地图 / Tab 预览等轻量场景直接使用，替代各处复制粘贴的
 * PREVIEW_MD_COMPONENTS 常量。
 */
export const MARKDOWN_PREVIEW_LIGHT_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="text-[11px] opacity-70 truncate">{children}</pre>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="text-[11px] bg-muted/50 px-0.5 rounded">{children}</code>
  ),
  img: () => null as unknown as React.ReactElement,
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
} as MarkdownComponentProps['components']

export interface MarkdownPreviewProps {
  /** Markdown 源文本 */
  children: string
  /** 显式传入时才添加外层容器，默认保持 Markdown 原有 DOM 层级 */
  className?: string
  /** 禁用图片渲染（预览/迷你地图场景，避免加载远程图） */
  disableImages?: boolean
  /** 链接渲染为纯文本（预览场景禁用跳转） */
  plainLinks?: boolean
  /** 启用数学公式（remark-math + rehype-katex） */
  math?: boolean
  /** 追加 remark 插件 */
  remarkPlugins?: MarkdownComponentProps['remarkPlugins']
  /** 追加 rehype 插件 */
  rehypePlugins?: MarkdownComponentProps['rehypePlugins']
  /** 自定义 URL 转换（白名单等场景） */
  urlTransform?: MarkdownComponentProps['urlTransform']
  /** 覆盖/追加标签渲染 */
  components?: MarkdownComponentProps['components']
}

/**
 * 轻量 Markdown 预览渲染器（react-markdown 管线统一入口）。
 *
 * 收敛目标：全产品散落的 `remarkPlugins={[remarkGfm]}` + 本地 components
 * 复制粘贴变体（TabPreviewPanel / scroll-minimap / AskUserBanner /
 * 设置页查看器等十余处）。重量级消息渲染（块选择/复制/mention）仍由
 * ai-elements/message.tsx 承担，两者共用此包但不共享复杂度。
 */
export function MarkdownPreview({
  children,
  className,
  disableImages = false,
  plainLinks = false,
  math = false,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
  components,
}: MarkdownPreviewProps): React.ReactElement {
  const remark = math
    ? [remarkGfm, remarkMath, ...(remarkPlugins ?? [])]
    : [remarkGfm, ...(remarkPlugins ?? [])]
  const rehype: NonNullable<MarkdownComponentProps['rehypePlugins']> = math
    ? [[rehypeKatex, { strict: 'ignore' as const }], ...(rehypePlugins ?? [])]
    : (rehypePlugins ?? [])

  const mergedComponents = {
    ...(disableImages ? { img: () => null as unknown as React.ReactElement } : null),
    ...(plainLinks
      ? { a: ({ children: c }: { children?: React.ReactNode }) => <span>{c}</span> }
      : null),
    ...components,
  } as MarkdownComponentProps['components']

  const content = (
    <Markdown
      remarkPlugins={remark}
      rehypePlugins={rehype.length > 0 ? rehype : undefined}
      urlTransform={urlTransform}
      components={mergedComponents}
    >
      {children}
    </Markdown>
  )
  return className === undefined ? content : <div className={className}>{content}</div>
}
