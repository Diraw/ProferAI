import * as React from 'react'
import { FileText, GripVertical, MessageSquareQuote, Quote, StickyNote, Trash2, BarChart3 } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { cn } from '@/lib/utils'
import { getQuotedSelectionKey } from '@/lib/quoted-selection'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import { getFileBaseName } from '@/lib/file-utils'

export type QuoteDropPlacement = 'before' | 'after'

interface QuotedSelectionListProps {
  /** 待发送引用列表，顺序即模型读到的先后 */
  items: QuotedSelection[]
  onRemove: (item: QuotedSelection) => void
  onMove: (sourceKey: string, targetKey: string, placement: QuoteDropPlacement) => void
}

const SOURCE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  file: FileText,
  'agent-history': MessageSquareQuote,
  'scratch-pad': StickyNote,
  visualization: BarChart3,
}

/** 列表展开上限：超过后内部滚动，避免把输入框顶掉 */
const MAX_VISIBLE_ROWS = 5

function resolveSourceLabel(item: QuotedSelection): string {
  if (item.sourceType === 'agent-history') {
    return item.sourceLabel ? `历史 · ${item.sourceLabel}` : 'Agent 历史'
  }
  if (item.sourceType === 'scratch-pad') return item.sourceLabel ?? '草稿纸'
  if (item.sourceType === 'visualization') return item.sourceLabel ?? '可视化'
  if (item.sourceType === 'agent-interruption') return item.sourceLabel ?? '中断说明'
  const base = getFileBaseName(item.filePath)
  if (typeof item.startLine === 'number' && typeof item.endLine === 'number') {
    return `${base}:${item.startLine}-${item.endLine}`
  }
  if (typeof item.startLine === 'number') return `${base}:${item.startLine}`
  return base || item.filePath
}

/**
 * 待发送引用列表（原「排队候选」面板的位置）。
 *
 * 与队列的差别：这里只累积引用，不触发任何发送；点发送时整组带走。
 * 顺序即模型读到的先后，所以保留拖拽排序。
 */
export function QuotedSelectionList({
  items,
  onRemove,
  onMove,
}: QuotedSelectionListProps): React.ReactElement | null {
  const [draggingKey, setDraggingKey] = React.useState<string | null>(null)
  const [dropTarget, setDropTarget] = React.useState<{ key: string; placement: QuoteDropPlacement } | null>(null)

  if (items.length === 0) return null

  const resolvePlacement = (event: React.DragEvent<HTMLDivElement>): QuoteDropPlacement => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
  }

  return (
    <div
      className="border-b border-border/35 bg-muted/[0.18] px-2.5 pt-2 pb-1.5"
      onDragEnter={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        event.stopPropagation()
        if (draggingKey) event.preventDefault()
      }}
      onDragLeave={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Quote className="size-3.5" />
          <span>待发送引用</span>
        </span>
        <span className="tabular-nums">{items.length}</span>
      </div>
      <div
        className={cn('space-y-1', items.length > MAX_VISIBLE_ROWS && 'max-h-[168px] overflow-y-auto pr-0.5')}
      >
        {items.map((item) => {
          const key = getQuotedSelectionKey(item)
          const isDragging = draggingKey === key
          const isDropBefore = dropTarget?.key === key && dropTarget.placement === 'before'
          const isDropAfter = dropTarget?.key === key && dropTarget.placement === 'after'
          const SourceIcon = SOURCE_ICON[item.sourceType ?? 'file'] ?? FileText

          return (
            <div
              key={key}
              draggable
              onDragStart={(event) => {
                event.stopPropagation()
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', key)
                setDraggingKey(key)
              }}
              onDragOver={(event) => {
                event.stopPropagation()
                if (!draggingKey || draggingKey === key) return
                event.preventDefault()
                setDropTarget({ key, placement: resolvePlacement(event) })
              }}
              onDrop={(event) => {
                event.stopPropagation()
                event.preventDefault()
                if (!draggingKey || draggingKey === key) return
                onMove(draggingKey, key, resolvePlacement(event))
                setDraggingKey(null)
                setDropTarget(null)
              }}
              onDragEnd={(event) => {
                event.stopPropagation()
                setDraggingKey(null)
                setDropTarget(null)
              }}
              className={cn(
                'relative flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                'bg-background/35 hover:bg-background/60',
                isDragging && 'opacity-45',
              )}
            >
              {isDropBefore && <div className="absolute left-2 right-2 top-0 h-0.5 rounded-full bg-primary" />}
              {isDropAfter && <div className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/55 active:cursor-grabbing" />
              <SourceIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] leading-4 text-muted-foreground">{resolveSourceLabel(item)}</div>
                <div className="truncate text-[13px] leading-5 text-foreground/80">{item.text}</div>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="移除引用"
                    className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-destructive"
                    onClick={() => onRemove(item)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>移除引用</p>
                </TooltipContent>
              </Tooltip>
            </div>
          )
        })}
      </div>
    </div>
  )
}
