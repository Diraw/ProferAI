/**
 * 可折叠长内容包装器
 *
 * 替代硬截断 2000 字符的方案：
 * - 短内容直接展示
 * - 长内容默认折叠，显示前 N 行（且不超过字符数上界）+ 长度指示器
 * - 展开分两档：按步长逐段推进，或一次性全部展开
 *
 * 折叠判定与预览切片都取自 sliceResultWindow：「该不该折叠」「折到多长」
 * 「还剩多少行」是同一个计算结果，不会出现按钮已出现、内容却早已全量渲染的不一致。
 *
 * 渐进展开是显式开启的：它只对「每行都会渲染成 DOM 元素」的渲染器有意义
 * （如终端逐行 <div>、文件列表）。Markdown、Grep 分组等非行结构的内容按行
 * 切片会破坏其结构，必须保持关闭。
 */

import * as React from 'react'
import { ChevronDown, ChevronsDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { canRevealByStep, describeRevealProgress, sliceResultWindow } from './collapsible-preview'

interface CollapsibleResultProps {
  /** 内容文本 */
  content: string
  /** 字符数上界，超过此值时启用折叠，默认 3000 */
  threshold?: number
  /** 折叠时显示的行数，默认 15 */
  previewLines?: number
  /**
   * 「再显示 N 行」的步长，默认 0 表示只提供一次性全部展开。
   *
   * 逐行渲染成 DOM 元素的渲染器（终端、文件列表）应显式传值，避免展开时
   * 一次性创建大量元素；非行结构的内容必须保持 0。
   */
  revealStep?: number
  /**
   * 自定义渲染函数，接收待渲染文本返回 JSX
   *
   * 第二个参数表示该文本是否只是片段：结构化结果（如 Grep 分组）
   * 无法按文本切行，需要据此自行收敛渲染量。
   */
  renderContent: (text: string, collapsed: boolean) => React.ReactNode
  /** 外层 className */
  className?: string
}

interface CollapseControlProps {
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}

function CollapseControl({ onClick, icon: Icon, children }: CollapseControlProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground/80"
    >
      <Icon className="size-3" />
      {children}
    </button>
  )
}

export function CollapsibleResult({
  content,
  threshold = 3000,
  previewLines = 15,
  revealStep = 0,
  renderContent,
  className,
}: CollapsibleResultProps): React.ReactElement {
  const safeContent = content ?? ''
  const [revealedLines, setRevealedLines] = React.useState(previewLines)
  const [fullyExpanded, setFullyExpanded] = React.useState(false)

  const resultWindow = React.useMemo(
    () => sliceResultWindow(safeContent, {
      maxChars: threshold,
      previewLines,
      revealedLines: fullyExpanded ? Number.POSITIVE_INFINITY : revealedLines,
    }),
    [safeContent, threshold, previewLines, revealedLines, fullyExpanded],
  )

  const collapse = React.useCallback((): void => {
    setFullyExpanded(false)
    setRevealedLines(previewLines)
  }, [previewLines])

  const revealMore = React.useCallback((): void => {
    setRevealedLines((current) => current + revealStep)
  }, [revealStep])

  const expandAll = React.useCallback((): void => setFullyExpanded(true), [])

  const canRevealMore = canRevealByStep(resultWindow, revealStep)
  const wasExpanded = fullyExpanded || revealedLines > previewLines

  // 括号里报「还剩多少」而非总量：点「全部展开」补上的正是这一部分
  const progress = describeRevealProgress(resultWindow, safeContent, previewLines)

  return (
    <div className={cn('relative', className)}>
      {renderContent(resultWindow.text, resultWindow.truncated)}

      {resultWindow.collapsed && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {resultWindow.truncated && canRevealMore && (
            <CollapseControl onClick={revealMore} icon={ChevronDown}>
              再显示 {revealStep} 行
            </CollapseControl>
          )}

          {resultWindow.truncated && (
            <CollapseControl onClick={expandAll} icon={ChevronsDown}>
              全部展开 (还剩 {progress.remaining.toLocaleString()} {progress.unit})
            </CollapseControl>
          )}

          {wasExpanded && (
            <CollapseControl onClick={collapse} icon={ChevronUp}>
              收起
            </CollapseControl>
          )}

          {resultWindow.truncated && (
            <span className="text-[11px] text-muted-foreground/40">
              已显示 {progress.revealed.toLocaleString()} / {progress.total.toLocaleString()} {progress.unit}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
