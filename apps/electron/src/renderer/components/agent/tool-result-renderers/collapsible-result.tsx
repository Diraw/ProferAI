/**
 * 可折叠长内容包装器
 *
 * 替代硬截断 2000 字符的方案：
 * - 短内容直接展示
 * - 长内容默认折叠，显示前 N 行（且不超过字符数上界）+ 长度指示器
 * - 点击展开/收起全部内容
 *
 * 折叠判定与预览切片都取自 sliceResultPreview：「该不该折叠」和「折到多长」
 * 是同一个计算结果，不会出现按钮已出现、内容却早已全量渲染的不一致。
 */

import * as React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sliceResultPreview } from './collapsible-preview'

interface CollapsibleResultProps {
  /** 内容文本 */
  content: string
  /** 字符数上界，超过此值时启用折叠，默认 3000 */
  threshold?: number
  /** 折叠时显示的行数，默认 15 */
  previewLines?: number
  /**
   * 自定义渲染函数，接收待渲染文本返回 JSX
   *
   * 第二个参数表示该文本是否只是折叠预览片段：结构化结果（如 Grep 分组）
   * 无法按文本切行，需要据此自行收敛渲染量。
   */
  renderContent: (text: string, collapsed: boolean) => React.ReactNode
  /** 外层 className */
  className?: string
}

export function CollapsibleResult({
  content,
  threshold = 3000,
  previewLines = 15,
  renderContent,
  className,
}: CollapsibleResultProps): React.ReactElement {
  const safeContent = content ?? ''
  const [expanded, setExpanded] = React.useState(false)

  const preview = React.useMemo(
    () => sliceResultPreview(safeContent, { maxChars: threshold, previewLines }),
    [safeContent, threshold, previewLines],
  )

  const showingPreview = preview.collapsed && !expanded
  const displayContent = showingPreview ? preview.text : safeContent
  const totalLines = React.useMemo(() => safeContent.split('\n').length, [safeContent])

  return (
    <div className={cn('relative', className)}>
      {renderContent(displayContent, showingPreview)}

      {preview.collapsed && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 mt-1.5 text-[11px] text-muted-foreground/60 hover:text-foreground/80 transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="size-3" />
              显示全部 ({safeContent.length.toLocaleString()} 字符, {totalLines} 行)
            </>
          )}
        </button>
      )}
    </div>
  )
}
