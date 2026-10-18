/**
 * ScrollMinimap — 消息导航迷你地图 + 滚动进度条
 *
 * 在消息区域右侧显示：
 * 1. 短横杠代表每条消息的位置（迷你地图），悬浮时弹出消息预览列表
 * 2. 可拖拽的滚动进度条，提供丝滑的滚动体验
 * 必须放在 StickToBottom（Conversation）内部使用。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { MarkdownPreview, MARKDOWN_PREVIEW_LIGHT_COMPONENTS } from '@profer/ui'
import { AlertTriangle, Search } from 'lucide-react'
import { useConversationScroll } from './conversation-scroll'
import { Input } from '@profer/ui/primitives/input'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { channelsAtom } from '@/atoms/chat-atoms'
import { useShortcut } from '@/hooks/useShortcut'
import { cn } from '@/lib/utils'
import { navigationItemKey } from '@/lib/navigation-item-key'

export interface MinimapItem {
  /** 滚动锚点 id（消息 uuid）；无 uuid 时为 null，需用 matchKey 在本地 DOM 里回退匹配 */
  id: string | null
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
  /**
   * 无 id 时的稳定匹配键（`${role}:${subtype}:${createdAt}`）。
   * 导航索引覆盖全会话，而后行不在 DOM 里；有 id 的行用 id，无 id 的行用它扫已加载的
   * `data-message-nav-key` 节点。两者皆无才标为“未加载”。
   */
  matchKey?: string
}

interface ScrollMinimapProps {
  items: MinimapItem[]
  /**
   * 拉取更早一页消息（命中不了旧条目时调用）。不传则不提供“加载更早”入口。
   */
  onRequestEarlier?: () => void
}

/** 最少消息数才显示迷你地图 */
const MIN_ITEMS = 1
/** 迷你地图最多渲染的横杠数 */
const MAX_BARS = 20
/**
 * 面板列表最多渲染的行数。
 *
 * 导航总数覆盖全会话（可达成百上千轮），但面板开启时每次滚动都会重算可见项并重渲染列表，
 * 全量渲染（含 markdown 预览）会拖慢滚动。历史区段本来就要先「加载更早消息」才能跳，
 * 这里只渲染最近的 N 行，总数仍显示真实值（不随窗口/折叠/截断变化）。
 */
const MAX_LIST_ITEMS = 200

// ── 辅助函数 ──

/**
 * 在已渲染的 DOM 里找导航条目对应的节点。
 * 有 uuid 的用 data-message-id；无 uuid 的（interruption_record 等）用 data-message-nav-key。
 */
function findMessageNode(el: HTMLElement, id: string | null, matchKey?: string): HTMLElement | null {
  if (id) {
    const byId = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.getAttribute('data-message-id') === id
    )
    if (byId) return byId
  }
  if (matchKey) {
    return Array.from(el.querySelectorAll<HTMLElement>('[data-message-nav-key]')).find(
      (node) => node.getAttribute('data-message-nav-key') === matchKey
    ) ?? null
  }
  return null
}

/** 节点是否与主区视口相交（与 visibleIds 的几何判定同一口径）。 */
function isNodeInViewport(
  node: HTMLElement,
  container: HTMLElement,
  scrollTop: number,
  clientHeight: number,
): boolean {
  const top = getOffsetTopRelativeTo(node, container)
  const bottom = top + node.offsetHeight
  return bottom > scrollTop && top < scrollTop + clientHeight
}

/** 计算 node 相对于 container 的实际顶部偏移（递归累积 offsetTop） */
function getOffsetTopRelativeTo(node: HTMLElement, container: HTMLElement): number {
  let top = 0
  let el: HTMLElement | null = node
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

/** 转义正则特殊字符 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface MinimapViewportState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  ids: Set<string>
  keys: Set<string>
  centerId?: string
}

function sameIds(previous: Set<string>, next: Set<string>): boolean {
  return previous.size === next.size && [...next].every(id => previous.has(id))
}

/** 同一帧只测量一次；相同几何与高亮不提交 React 状态。 */
export function observeMinimapViewport(
  el: HTMLElement,
  content: HTMLElement | null,
  changed: (state: MinimapViewportState) => void,
): () => void {
  let frame: number | null = null
  let previous: MinimapViewportState | undefined
  const update = (): void => {
    frame = null
    const { scrollTop, scrollHeight, clientHeight } = el
    const ids = new Set<string>()
    const keys = new Set<string>()
    const center = scrollTop + clientHeight / 2
    let centerId: string | undefined
    for (const node of el.querySelectorAll<HTMLElement>('[data-message-id], [data-message-nav-key]')) {
      const top = getOffsetTopRelativeTo(node, el)
      const bottom = top + node.offsetHeight
      const id = node.getAttribute('data-message-id')
      const key = node.getAttribute('data-message-nav-key')
      if (bottom > scrollTop && top < scrollTop + clientHeight) {
        if (id) ids.add(id)
        if (key) keys.add(key)
      }
      if (centerId === undefined && id && top <= center && bottom > center) centerId = id
    }
    if (previous && previous.scrollTop === scrollTop && previous.scrollHeight === scrollHeight
      && previous.clientHeight === clientHeight && previous.centerId === centerId
      && sameIds(previous.ids, ids) && sameIds(previous.keys, keys)) return
    const state = {
      scrollTop, scrollHeight, clientHeight, centerId,
      ids: previous && sameIds(previous.ids, ids) ? previous.ids : ids,
      keys: previous && sameIds(previous.keys, keys) ? previous.keys : keys,
    }
    previous = state
    changed(state)
  }
  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(update)
  }
  schedule()
  el.addEventListener('scroll', schedule, { passive: true })
  const observer = new ResizeObserver(schedule)
  observer.observe(el)
  if (content) observer.observe(content)
  return () => {
    el.removeEventListener('scroll', schedule)
    observer.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
  }
}

// ── 主组件 ──

export function ScrollMinimap({ items, onRequestEarlier }: ScrollMinimapProps): React.ReactElement | null {
  const { scrollRef, contentRef, pause, navigate, beginLayout } = useConversationScroll()
  const [hovered, setHovered] = React.useState(false)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const [visibleIds, setVisibleIds] = React.useState<Set<string>>(new Set())
  /** 视口内无 uuid 条目的匹配键（用于高亮），与 visibleIds 同时机更新 */
  const [visibleNavKeys, setVisibleNavKeys] = React.useState<Set<string>>(new Set())
  /** 面板打开时快照：本地 DOM 里真正存在的消息 id（有 uuid 的） */
  const [loadedIds, setLoadedIds] = React.useState<Set<string>>(new Set())
  /** 面板打开时快照：本地 DOM 里无 uuid 条目的匹配键（如 interruption_record）；
   *  用“是否在 DOM”而非“是否在视口”，否则滚出屏幕的已加载行会被误标为未加载。 */
  const [loadedNavKeys, setLoadedNavKeys] = React.useState<Set<string>>(new Set())
  /** 主区视口几何中心当前对应的消息 id —— 面板打开时作为列表居中锚点 */
  const [centerVisibleId, setCenterVisibleId] = React.useState<string | undefined>(undefined)
  const [canScroll, setCanScroll] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [isDragging, setIsDragging] = React.useState(false)
  const [scrollMetrics, setScrollMetrics] = React.useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 })
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  // ── 组件卸载时清理计时器 ──

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
    }
  }, [])

  // ── 可见消息 + 滚动指标追踪 ──

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    return observeMinimapViewport(el, contentRef.current, ({ scrollTop, scrollHeight, clientHeight, ids, keys, centerId }) => {
      setCanScroll(scrollHeight > clientHeight + 10)
      setScrollMetrics(previous => previous.scrollTop === scrollTop && previous.scrollHeight === scrollHeight
        && previous.clientHeight === clientHeight ? previous : { scrollTop, scrollHeight, clientHeight })
      setVisibleIds(previous => sameIds(previous, ids) ? previous : ids)
      setVisibleNavKeys(previous => sameIds(previous, keys) ? previous : keys)
      setCenterVisibleId(centerId)
    })
  }, [scrollRef, contentRef, items])

  // ── 面板打开时自动聚焦搜索框 ──

  React.useEffect(() => {
    if (hovered && searchInputRef.current) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 80)
      return () => clearTimeout(timer)
    }
  }, [hovered])

  // ── 面板打开时把当前可见消息滚到列表中间，避免每次都从顶部开始 ──

  React.useEffect(() => {
    if (!hovered) return
    const timer = setTimeout(() => {
      const list = listRef.current
      if (!list) return
      const target = list.querySelector<HTMLElement>('[data-minimap-visible="true"]')
      if (!target) return
      // listRef 没有 position 设置，offsetTop / getOffsetTopRelativeTo 都不可靠，
      // 直接用 getBoundingClientRect 计算 target 相对 list 视口的偏移
      const listRect = list.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const offsetInList = (targetRect.top - listRect.top) + list.scrollTop
      const offset = offsetInList - (list.clientHeight - target.offsetHeight) / 2
      list.scrollTo({ top: Math.max(0, offset), behavior: 'auto' })
    }, 0)
    return () => clearTimeout(timer)
  }, [hovered])

  // ── 面板关闭时清空搜索 ──

  React.useEffect(() => {
    if (!hovered) setSearchQuery('')
  }, [hovered])

  // ── “已加载于本地 DOM”快照 ──
  //
  // 导航索引覆盖全会话，但本会话只加载了尾部一页消息（更早的要点「加载更早消息」才渲染）。
  // 面板需要区分「点得动」与「还没加载」：前者按 id（有 uuid）或 nav-key 在 DOM 里命中。
  // 只在面板打开时扫一次，不挂到滚动热路径上。

  React.useEffect(() => {
    if (!hovered) {
      setLoadedIds(new Set())
      setLoadedNavKeys(new Set())
      return
    }
    const el = scrollRef.current
    if (!el) return
    const ids = new Set<string>()
    for (const node of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const id = node.getAttribute('data-message-id')
      if (id) ids.add(id)
    }
    const keys = new Set<string>()
    for (const node of el.querySelectorAll<HTMLElement>('[data-message-nav-key]')) {
      const key = node.getAttribute('data-message-nav-key')
      if (key) keys.add(key)
    }
    setLoadedIds(ids)
    setLoadedNavKeys(keys)
  }, [hovered, scrollRef, items])

  // ── Cmd+F / Ctrl+F 快捷键：打开面板并聚焦搜索 ──

  const handleShortcutOpen = React.useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = undefined }
    setIsLeaving(false)
    setHovered(true)
  }, [])

  useShortcut('file-find', handleShortcutOpen, items.length >= MIN_ITEMS && canScroll)

  // ── 鼠标进出控制（仅迷你地图区域） ──

  /** 鼠标进入后需停留此时间（ms）才展开面板，防止掠过时闪烁 */
  const OPEN_DELAY = 180

  const handleMouseEnter = (): void => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)

    // 面板已打开则无需重复触发
    if (hovered) return

    // 延迟打开：鼠标需在触发条上停留足够时间
    if (!openTimerRef.current) {
      openTimerRef.current = setTimeout(() => {
        setHovered(true)
        openTimerRef.current = undefined
      }, OPEN_DELAY)
    }
  }

  const handleMouseLeave = (): void => {
    // 尚未打开就离开了 → 取消打开定时器
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = undefined
    }

    if (!hovered) return

    closeTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setHovered(false)
        setIsLeaving(false)
      }, 80)
    }, 40)
  }

  // ── 跳转到指定消息（直接操作 scrollTop，绕过 scrollIntoView） ──
  //
  // 导航索引覆盖全会话，但更早的行可能还没加载进 DOM。命中不了且仍有更早历史时，
  // 先拉起更早一页，让用户知道「在加载」而不是点了没反应；已加载到底则静默返回。

  const scrollToMessage = React.useCallback((id: string | null, matchKey?: string) => {
    const el = scrollRef.current
    if (!el) return
    const target = findMessageNode(el, id, matchKey)
    if (!target) {
      // 还没加载到那条历史：先拉起更早一页。
      // prepend 会把内容整体向下推，必须当锚点布局事务处理，否则用户会被推离当前位置。
      if (onRequestEarlier) {
        const finish = beginLayout(contentRef.current ?? undefined)
        onRequestEarlier()
        // 内容异步到达；下一帧结束事务，让控制器在新高度下把锚点抳回原位。
        window.setTimeout(finish, 0)
      }
      return
    }
    const offsetTop = getOffsetTopRelativeTo(target, el)
    const targetHeight = target.offsetHeight
    const viewportHeight = el.clientHeight
    const scrollTarget = targetHeight < viewportHeight
      ? offsetTop - (viewportHeight - targetHeight) / 2
      : offsetTop - 32
    navigate(Math.max(0, scrollTarget))

    setHovered(false)
  }, [scrollRef, contentRef, navigate, onRequestEarlier, beginLayout])

  // ── 搜索过滤 ──

  /** 导航条目的唯一键：有 uuid 用 uuid，无 uuid 用匹配键 */
  const navKeyOf = navigationItemKey

  /**
   * 该条目是否已在本会话的 DOM 里。
   *
   * 导航索引覆盖全会话，但只加载了尾部一页；更早的条目点不动（需要先加载），
   * 面板据此把它们标为「未加载」，而不是让用户以为点了没反应。
   */
  const isLoaded = React.useCallback(
    (item: MinimapItem): boolean => {
      if (item.id) return loadedIds.has(item.id)
      if (item.matchKey) return loadedNavKeys.has(item.matchKey)
      return false
    },
    [loadedIds, loadedNavKeys],
  )

  /** 该条目当前是否在视口内（用于高亮与悬浮定位）。 */
  const isOnScreen = React.useCallback(
    (item: MinimapItem): boolean => (item.id ? visibleIds.has(item.id) : item.id === null && item.matchKey !== undefined ? visibleNavKeys.has(item.matchKey) : false),
    [visibleIds, visibleNavKeys],
  )

  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((item) => item.preview.toLowerCase().includes(q))
  }, [items, searchQuery])

  const loadedCount = React.useMemo(() => items.filter(isLoaded).length, [items, isLoaded])

  /** 列表居中锚点：优先用主区视口中心对应的消息；该消息被搜索过滤掉时退回第一条可见消息 */
  const anchorKey = React.useMemo(() => {
    const centerItem = centerVisibleId
      ? filteredItems.find((item) => item.id === centerVisibleId)
      : undefined
    const onScreenItem = centerItem ?? filteredItems.find(isOnScreen)
    return onScreenItem ? navigationItemKey(onScreenItem) : undefined
  }, [centerVisibleId, filteredItems, isOnScreen])

  /** 当前阅读位置（1 基）。找不到可见条目时为 0，面板显示为「—」。
   *  语义是“当前在全部轮次里的第几条”，不再用旧实现那种“可见/总数”的双重含义。 */
  const anchorIndex = React.useMemo(() => {
    if (!anchorKey) return 0
    return filteredItems.findIndex((item) => navigationItemKey(item) === anchorKey) + 1
  }, [anchorKey, filteredItems])

  //
  // 只渲染列表窗口（见 MAX_LIST_ITEMS）；窗口围绕当前阅读位置，而不是固定取尾部：
  // 否则用户上滚阅读时，面板里的高亮行会被挤出窗口，看不到自己读到哪。
  // 计数/位置指示仍用全量 filteredItems。
  const listItems = React.useMemo(() => {
    if (filteredItems.length <= MAX_LIST_ITEMS) return filteredItems
    if (anchorIndex <= 0) return filteredItems.slice(-MAX_LIST_ITEMS)
    const half = Math.floor(MAX_LIST_ITEMS / 2)
    const start = Math.max(0, Math.min(anchorIndex - 1 - half, filteredItems.length - MAX_LIST_ITEMS))
    return filteredItems.slice(start, start + MAX_LIST_ITEMS)
  }, [filteredItems, anchorIndex])

  // ── 滚动条滑块拖拽 ──

  const handleThumbMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const el = scrollRef.current
    const track = trackRef.current
    if (!el || !track) return

    pause()

    setIsDragging(true)
    const startY = e.clientY
    const startScrollTop = el.scrollTop
    const trackHeight = track.clientHeight
    const { scrollHeight, clientHeight } = el
    const scrollRange = scrollHeight - clientHeight
    const thumbHeight = Math.max(trackHeight * 0.1, (clientHeight / scrollHeight) * trackHeight)
    const scrollableTrack = trackHeight - thumbHeight

    const onMouseMove = (ev: MouseEvent): void => {
      ev.preventDefault()
      const delta = ev.clientY - startY
      const scrollDelta = scrollableTrack > 0 ? (delta / scrollableTrack) * scrollRange : 0
      navigate(Math.max(0, Math.min(scrollRange, startScrollTop + scrollDelta)), false)
    }

    const onMouseUp = (): void => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [scrollRef, pause, navigate])

  // ── 轨道点击跳转 ──
  const handleTrackMouseDown = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 只响应直接点击轨道背景，忽略点击滑块
    if (e.target !== e.currentTarget) return

    const track = trackRef.current
    const el = scrollRef.current
    if (!track || !el) return

    const rect = track.getBoundingClientRect()
    const clickRatio = (e.clientY - rect.top) / rect.height
    const { scrollHeight, clientHeight } = el
    const targetTop = clickRatio * (scrollHeight - clientHeight)
    navigate(Math.max(0, targetTop))
  }, [scrollRef, navigate])

  if (items.length < MIN_ITEMS || !canScroll) return null

  // ── 迷你地图条纹 ──

  const barCount = Math.min(items.length, MAX_BARS)

  // ── 滚动条滑块尺寸计算 ──

  const { scrollTop, scrollHeight, clientHeight } = scrollMetrics
  const scrollRange = scrollHeight - clientHeight
  const thumbRatio = scrollHeight > 0 ? Math.min(clientHeight / scrollHeight, 1) : 1
  const thumbHeightPct = Math.max(10, thumbRatio * 100)
  const thumbTopPct = scrollRange > 0 ? (scrollTop / scrollRange) * (100 - thumbHeightPct) : 0

  return (
    <div className="absolute right-1 top-0 bottom-0 z-30 flex pointer-events-none">
      {/* ── 迷你地图悬停区域（面板 + 横杠） ── */}
      <div className="flex items-start h-full">
        {/* 展开面板 */}
        {hovered && (
          <div
            className={cn(
              'mr-1 w-[280px] rounded-lg border bg-popover shadow-xl origin-top-right flex flex-col overflow-hidden pointer-events-auto',
              isLeaving
                ? 'animate-out fade-out-0 zoom-out-95 duration-75'
                : 'animate-in fade-in-0 zoom-in-95 duration-150'
            )}
            style={{ maxHeight: 'min(420px, 60vh)', marginTop: 12 }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
              <span className="text-xs font-medium text-popover-foreground/70">消息导航</span>
              {/* 位置指示（当前阅读位置 / 全会话总数）。总数来自主进程的全量轮次索引，
                  不随渲染窗口、分页或折叠变化；加载历史不会把分母改小。 */}
              <span
                className="text-[11px] text-muted-foreground tabular-nums"
                title={`已加载 ${loadedCount}/${items.length} 条`}
              >
                {anchorIndex > 0 ? `${anchorIndex}/${items.length}` : `—/${items.length}`}
              </span>
            </div>

            {/* 搜索框 */}
            <div className="px-2 py-1.5 border-b shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
                <Input
                  ref={searchInputRef}
                  placeholder="搜索消息..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => {
                    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
                    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
                    setIsLeaving(false)
                  }}
                  className="h-7 text-xs pl-7"
                />
              </div>
            </div>

            {/* 消息列表 */}
            <div ref={listRef} className="overflow-y-auto flex-1 p-1.5 space-y-0.5 scrollbar-thin">
              {filteredItems.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  未找到匹配消息
                </div>
              ) : (
                listItems.map((item) => (
                  <MinimapRow
                    key={navKeyOf(item)}
                    item={item}
                    isAnchor={navKeyOf(item) === anchorKey}
                    loaded={isLoaded(item)}
                    onScreen={isOnScreen(item)}
                    query={searchQuery}
                    onSelect={scrollToMessage}
                  />
                ))
              )}
            </div>
          </div>
        )}

        {/* ── 迷你地图横杠（紧凑排列）—— 只有这里触发面板展开 ── */}
        <div
          className="relative mt-3 flex-shrink-0 pointer-events-auto"
          style={{ width: 24, height: barCount * 6 }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {Array.from({ length: barCount }, (_, i) => {
            const start = Math.floor((i * items.length) / barCount)
            const end = Math.floor(((i + 1) * items.length) / barCount)
            const group = items.slice(start, end)
            const isVisible = group.some(isOnScreen)
            // 未加载的横杠去掉高亮（只保留弱底色），以免“还没加载”和“已加载但不在视口”混淆。
            const isLoadedInGroup = group.some(isLoaded)
            const hasUser = group.some((it) => it.role === 'user')
            const top = ((i + 0.5) / barCount) * 100
            return (
              <div
                key={i}
                className={cn(
                  'absolute left-1 h-[2px] w-[20px] rounded-full transition-colors',
                  isVisible
                    ? 'bg-primary dark:bg-primary/70 minimap-visible-indicator'
                    : hasUser
                      ? 'bg-primary/25 dark:bg-primary/15'
                      : 'bg-primary/40 dark:bg-primary/25',
                  !isLoadedInGroup && 'opacity-40'
                )}
                style={{ top: `${top}%` }}
              />
            )
          })}
        </div>
      </div>

      {/* ── 滚动进度条 ── */}
      <div className="relative ml-[4px] py-4 flex-shrink-0 pointer-events-auto" style={{ width: 7 }}>
        <div
          ref={trackRef}
          className="relative h-full rounded-full cursor-pointer scroll-progress-track"
          onMouseDown={handleTrackMouseDown}
        >
          <div
            className={cn(
              'absolute left-0 right-0 rounded-full transition-colors duration-100 scroll-progress-thumb',
              isDragging
                ? 'scroll-progress-thumb-active cursor-grabbing'
                : 'cursor-grab'
            )}
            style={{
              height: `${thumbHeightPct}%`,
              top: `${thumbTopPct}%`,
            }}
            onMouseDown={handleThumbMouseDown}
          />
        </div>
      </div>
    </div>
  )
}

// ── 子组件 ──

/**
 * 面板列表的一行。独立出来 memo 化：面板开启时滚动会持续重算“可见/已加载”状态，
 * 避免每行（含 markdown 预览）在无关项变化时重建。
 */
const MinimapRow = React.memo(function MinimapRow({
  item,
  isAnchor,
  loaded,
  onScreen,
  query,
  onSelect,
}: {
  item: MinimapItem
  isAnchor: boolean
  loaded: boolean
  onScreen: boolean
  query: string
  onSelect: (id: string | null, matchKey?: string) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      data-minimap-visible={isAnchor ? 'true' : undefined}
      title={loaded ? undefined : '尚未加载这条历史，点击将先加载更早消息'}
      className={cn(
        'flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
        onScreen && 'bg-accent/50',
        !loaded && 'opacity-45'
      )}
      onClick={() => onSelect(item.id, item.matchKey)}
    >
      <ItemIcon item={item} />
      <div className="flex-1 min-w-0">
        <HighlightedPreview text={item.preview} query={query} />
      </div>
    </button>
  )
})

function ItemIcon({ item }: { item: MinimapItem }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (item.role === 'user' && item.avatar) {
    return <UserAvatar avatar={item.avatar} size={16} className="mt-0.5" />
  }
  if ((item.role === 'assistant') && item.model) {
    return (
      <img
        src={getModelLogo(item.model, resolveModelProvider(item.model, channels))}
        alt=""
        className="size-4 shrink-0 mt-0.5 rounded-[20%] object-cover"
      />
    )
  }
  if (item.role === 'status') {
    return <AlertTriangle className="size-4 shrink-0 mt-0.5 text-destructive" />
  }
  return <div className="size-4 shrink-0 mt-0.5 rounded-[20%] bg-muted" />
}

/** Markdown 预览（无搜索时）或 纯文本+高亮（搜索时） */
function HighlightedPreview({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!text) {
    return <span className="text-xs opacity-40">(空消息)</span>
  }

  if (query.trim()) {
    const escaped = escapeRegExp(query)
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
    return (
      <span className="text-xs text-popover-foreground/80 line-clamp-3">
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase()
            ? <mark key={i} className="bg-primary/20 text-primary rounded-sm px-0.5">{part}</mark>
            : part
        )}
      </span>
    )
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-popover-foreground/80 prose-p:my-0 prose-headings:my-0.5 prose-headings:text-xs prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-3 overflow-hidden">
      <MarkdownPreview components={MARKDOWN_PREVIEW_LIGHT_COMPONENTS}>
        {text}
      </MarkdownPreview>
    </div>
  )
}
