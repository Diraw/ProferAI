import * as React from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Popover, PopoverContent, PopoverTrigger } from '@profer/ui/primitives/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { cn } from '@/lib/utils'

export type ComposerToolbarPlacement = 'toolbar' | 'overflow'
export type ToolbarItemPlacement = ComposerToolbarPlacement

/** 输入工具的声明式配置。业务组件只负责 render，布局与折叠由 ComposerToolbar 统一处理。 */
export interface ComposerToolbarItem {
  key: string
  node?: React.ReactNode
  render?: (placement: ComposerToolbarPlacement) => React.ReactNode
  label?: string
  /** false 时始终留在主栏，例如模型、发送前的核心动作。 */
  canOverflow?: boolean
  /** 同一栏位中的稳定排序；数值越小越靠左。 */
  order?: number
  /** 条件配置入口；false 的条目不会挂载，也不会参与测量。 */
  visible?: boolean
}

export type ToolbarItem = ComposerToolbarItem

interface ComposerToolbarProps {
  items: ComposerToolbarItem[]
  trailing?: React.ReactNode
  gapPx?: number
  moreButtonPx?: number
  className?: string
}

const DEFAULT_GAP_PX = 6
const DEFAULT_MORE_BUTTON_PX = 36

function sortItems(items: ComposerToolbarItem[]): ComposerToolbarItem[] {
  return items
    .filter((item) => item.visible !== false)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? a.index) - (b.item.order ?? b.index))
    .map(({ item }) => item)
}

function itemWidth(item: ComposerToolbarItem, widths: Record<string, number>): number {
  return widths[item.key] ?? 0
}

function layoutWidth(items: ComposerToolbarItem[], widths: Record<string, number>, gapPx: number): number {
  return items.reduce((total, item, index) => total + itemWidth(item, widths) + (index > 0 ? gapPx : 0), 0)
}

/** 纯布局决策，供组件和测试共用；固定项永远留在主栏，其余项按声明顺序折叠。 */
export function resolveComposerToolbarLayout(input: {
  items: ComposerToolbarItem[]
  widths: Record<string, number>
  containerWidth: number
  gapPx?: number
  moreButtonPx?: number
}): { visible: ComposerToolbarItem[]; overflow: ComposerToolbarItem[] } {
  const { items, widths, containerWidth, gapPx = DEFAULT_GAP_PX, moreButtonPx = DEFAULT_MORE_BUTTON_PX } = input
  if (containerWidth <= 0) return { visible: items, overflow: [] }
  if (layoutWidth(items, widths, gapPx) <= containerWidth) return { visible: items, overflow: [] }

  const fixed = items.filter((item) => item.canOverflow === false)
  const optional = items.filter((item) => item.canOverflow !== false)
  const selected = new Set(fixed.map((item) => item.key))
  const hasMoreWidth = moreButtonPx + gapPx

  for (const item of optional) {
    const next = items.filter((candidate) => selected.has(candidate.key) || candidate.key === item.key)
    if (layoutWidth(next, widths, gapPx) + hasMoreWidth <= containerWidth) selected.add(item.key)
  }

  const visible = items.filter((item) => selected.has(item.key))
  const overflow = items.filter((item) => !selected.has(item.key))
  return { visible, overflow }
}

function getOverflowItems(items: ComposerToolbarItem[], visible: ComposerToolbarItem[]): ComposerToolbarItem[] {
  const visibleKeys = new Set(visible.map((item) => item.key))
  return items.filter((item) => !visibleKeys.has(item.key))
}

export function ComposerToolbar({
  items: declaredItems,
  trailing,
  gapPx = DEFAULT_GAP_PX,
  moreButtonPx = DEFAULT_MORE_BUTTON_PX,
  className,
}: ComposerToolbarProps): React.ReactElement {
  const items = React.useMemo(() => sortItems(declaredItems), [declaredItems])
  const containerRef = React.useRef<HTMLDivElement>(null)
  const itemRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  const [containerWidth, setContainerWidth] = React.useState(0)
  const [itemWidths, setItemWidths] = React.useState<Record<string, number>>({})
  const [popoverOpen, setPopoverOpen] = React.useState(false)

  React.useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    setContainerWidth(element.getBoundingClientRect().width)
    let frame = 0
    const observer = new ResizeObserver((entries) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const entry = entries[0]
        if (entry) setContainerWidth(entry.contentRect.width)
      })
    })
    observer.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  const readWidths = React.useCallback((): void => {
    setItemWidths((previous) => {
      const next = { ...previous }
      let changed = false
      for (const [key, element] of itemRefs.current) {
        const width = element.getBoundingClientRect().width
        if (width <= 0) continue
        if (next[key] === undefined || Math.abs(next[key]! - width) > 0.5) {
          next[key] = width
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [])

  const itemKeysSignature = items.map((item) => item.key).join('|')
  React.useLayoutEffect(() => {
    readWidths()
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(readWidths)
    })
    for (const element of itemRefs.current.values()) observer.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [itemKeysSignature, readWidths])

  const layout = React.useMemo(() => resolveComposerToolbarLayout({
    items,
    widths: itemWidths,
    containerWidth,
    gapPx,
    moreButtonPx,
  }), [containerWidth, gapPx, itemWidths, items, moreButtonPx])

  const visibleItems = layout.visible
  const overflowItems = getOverflowItems(items, visibleItems)
  const hasOverflow = overflowItems.length > 0

  const renderItem = React.useCallback((item: ComposerToolbarItem, placement: ComposerToolbarPlacement): React.ReactNode => {
    return item.render ? item.render(placement) : item.node
  }, [])

  const setItemRef = (key: string) => (element: HTMLDivElement | null): void => {
    if (element) itemRefs.current.set(key, element)
    else itemRefs.current.delete(key)
  }

  return (
    <div
      data-profer-navigation-region="toolbar"
      className={cn('flex h-[48px] items-center justify-between gap-4 px-2 py-1', className)}
    >
      <div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {visibleItems.map((item) => (
          <div key={item.key} ref={setItemRef(item.key)} className="flex shrink-0 items-center">
            {renderItem(item, 'toolbar')}
          </div>
        ))}
        {hasOverflow && (
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="size-[36px] shrink-0 rounded-md text-foreground/60 hover:bg-accent hover:text-foreground" aria-label="更多工具">
                    <MoreHorizontal className="size-5" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="top"><p>更多</p></TooltipContent>
            </Tooltip>
            <PopoverContent side="top" align="end" className="w-auto p-1.5" onOpenAutoFocus={(event) => event.preventDefault()}>
              <div className="flex items-center gap-1.5">
                {overflowItems.map((item) => (
                  <div key={item.key} className="flex shrink-0 items-center">
                    {renderItem(item, 'overflow')}
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>}
    </div>
  )
}
