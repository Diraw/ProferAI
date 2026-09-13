/**
 * AI Elements - 对话容器原语
 *
 * 基于 use-stick-to-bottom 实现自动滚动到底部的对话容器。
 * 移植自 profer-frontend 的 ai-elements/conversation.tsx。
 *
 * 包含：
 * - Conversation — 根容器（StickToBottom）
 * - ConversationContent — 内容区域
 * - ConversationEmptyState — 空状态
 * - ConversationScrollButton — 滚动到底部按钮
 */

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ArrowDownIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { getConversationScrollDebugOptions, type ConversationScrollAnchorMode } from './conversation-scroll-debug'
import { getViewportResizeFollowTarget } from './conversation-viewport-resize-follow'

// ===== Conversation 根容器 =====

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, resize, children, ...props }: ConversationProps): React.ReactElement {
  return (
    <StickToBottom
      className={cn('relative min-h-0 flex-1 overflow-y-hidden scrollbar-none', className)}
      initial="instant"
      resize={resize ?? 'instant'}
      role="log"
      {...props}
    >
      {children}
    </StickToBottom>
  )
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export function ConversationContent({ className, ...props }: ConversationContentProps): React.ReactElement {
  const scrollDebug = getConversationScrollDebugOptions(
    typeof window === 'undefined' ? '' : window.location.search,
    import.meta.env.DEV,
    import.meta.env.VITE_CONVERSATION_SCROLL_DEBUG === '1',
  )

  return (
    <>
      <StickToBottom.Content
        // 默认保留浏览器原生 scroll anchoring；开发态通过 query 参数将 class 实际加到
        // StickToBottom 的滚动元素，验证它是否会和库的 scrollTop 补偿竞争。
        scrollClassName={cn(
          'profer-scroll-region',
          scrollDebug.scrollAnchor === 'none' && 'overflow-anchor-none',
        )}
        className={cn('flex flex-col gap-1 py-4 px-8', className)}
        {...props}
      />
      <ConversationViewportResizeFollow />
      <ConversationScrollDiagnostics enabled={scrollDebug.enabled} scrollAnchor={scrollDebug.scrollAnchor} />
    </>
  )
}

/**
 * use-stick-to-bottom 默认只观察内容高度；此处补齐 scroll viewport（clientHeight）变化。
 *
 * 仅当用户原本锁定在底部时跟随，绝不改变正在阅读历史消息的用户位置。
 */
function ConversationViewportResizeFollow(): React.ReactElement | null {
  const { scrollRef, state, isAtBottom } = useStickToBottomContext()
  const isAtBottomRef = React.useRef(isAtBottom)

  React.useEffect(() => {
    isAtBottomRef.current = isAtBottom
  }, [isAtBottom])

  React.useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const syncToBottom = (): void => {
      const targetScrollTop = getViewportResizeFollowTarget({
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
        scrollTop: state.scrollTop,
        isAtBottom: isAtBottomRef.current,
      })
      if (targetScrollTop === null) return
      // 使用库暴露的 state.scrollTop setter：它内部处理 scroll-behavior 覆盖并设置
      // ignoreScrollToTop，因此不会被库自己的 handleScroll 误判为“用户向上逃脱”。
      state.scrollTop = targetScrollTop
    }

    // 关键：用 window resize 而不是仅靠 ResizeObserver。
    // resize 事件在“更新渲染”流程的 resize steps 阶段派发，早于本帧 layout 与 paint；
    // 此处读取 clientHeight 会强制用新 viewport 完成布局，因此同帧写入即生效。
    // 实测 ResizeObserver 回调会晚一帧交付：拖拽时底部内容持续晚一帧跟随（幅度等于该帧
    // 高度增量，可达 5～30px），观感就是“界面底部反复闪动”。
    window.addEventListener('resize', syncToBottom)

    // 兜底：composer 高度变化等不经过 window resize 的 clientHeight 变化。
    const observer = new ResizeObserver(syncToBottom)
    observer.observe(scrollElement)

    return () => {
      window.removeEventListener('resize', syncToBottom)
      observer.disconnect()
    }
  }, [scrollRef, state])

  return null
}

interface ConversationScrollDiagnosticsProps {
  enabled: boolean
  scrollAnchor: ConversationScrollAnchorMode
}

/** 诊断用：最后一次 resize 之后多久算本次会话收敛（仅影响日志聚合）。 */
const DIAGNOSTIC_SETTLE_TIMEOUT_MS = 180

/**
 * 调查窗口 resize 时的消息跳位。
 *
 * 只在开发环境且 URL 带 `conversationScrollDebug=1` 时运行。日志使用一个 resize
 * 会话聚合多种事件，便于比较浏览器 scroll anchoring 与 use-stick-to-bottom 的补偿。
 */
function ConversationScrollDiagnostics({
  enabled,
  scrollAnchor,
}: ConversationScrollDiagnosticsProps): React.ReactElement | null {
  const { scrollRef, isAtBottom } = useStickToBottomContext()
  const isAtBottomRef = React.useRef(isAtBottom)

  React.useEffect(() => {
    isAtBottomRef.current = isAtBottom
  }, [isAtBottom])

  React.useEffect(() => {
    if (!enabled) return

    const scrollElement = scrollRef.current
    if (!scrollElement) return

    let activeSession = false
    let sessionId = 0
    let frameId: number | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const pendingReasons = new Set<string>()

    const getComposer = (): HTMLElement | null => {
      const conversation = scrollElement.closest<HTMLElement>('[data-profer-navigation-region="conversation"]')
      return conversation?.querySelector<HTMLElement>('[data-input-mode] .agent-input-surface') ?? null
    }

    const logSnapshot = (reason: string): void => {
      const composerRect = getComposer()?.getBoundingClientRect()
      const messageElements = scrollElement.querySelectorAll<HTMLElement>('[data-message-id]')
      const lastMessage = messageElements.item(messageElements.length - 1)
      const lastMessageRect = lastMessage?.getBoundingClientRect()
      const targetScrollTop = Math.max(0, scrollElement.scrollHeight - 1 - scrollElement.clientHeight)

      const payload = {
        reason,
        sessionId,
        scrollAnchor,
        innerHeight: window.innerHeight,
        // 界面自身底部边界：与固定不动的原生窗口底边对照，定位“界面底边在跳”的层次。
        docClientHeight: document.documentElement.clientHeight,
        rootBottom: Math.round(document.getElementById('root')?.getBoundingClientRect().bottom ?? -1),
        shellBottom: Math.round(document.querySelector<HTMLElement>('[data-profer-navigation-region="conversation"]')?.getBoundingClientRect().bottom ?? -1),
        scrollTop: scrollElement.scrollTop,
        clientHeight: scrollElement.clientHeight,
        scrollHeight: scrollElement.scrollHeight,
        targetScrollTop,
        distanceToTarget: targetScrollTop - scrollElement.scrollTop,
        isAtBottom: isAtBottomRef.current,
        composerTop: composerRect?.top ?? null,
        composerBottom: composerRect?.bottom ?? null,
        composerHeight: composerRect?.height ?? null,
        lastMessageId: lastMessage?.dataset.messageId ?? null,
        lastMessageTop: lastMessageRect?.top ?? null,
        lastMessageBottom: lastMessageRect?.bottom ?? null,
        lastMessageToComposer: lastMessageRect && composerRect ? composerRect.top - lastMessageRect.bottom : null,
        timestamp: performance.now(),
        // 与主进程 window-geometry-debug.jsonl 的 epoch 对齐，便于核对原生窗口几何与 renderer 布局的时序差。
        epoch: Date.now(),
      }
      console.info(`[CONVERSATION-SCROLL-DEBUG] ${JSON.stringify(payload)}`)
    }

    const scheduleSnapshot = (reason: string): void => {
      pendingReasons.add(reason)
      if (frameId !== null) return

      frameId = requestAnimationFrame(() => {
        frameId = null
        logSnapshot([...pendingReasons].join('+'))
        pendingReasons.clear()
      })
    }

    // 双 rAF 快照：越过本帧 paint，记录“实际绘制出来的那一帧”的状态。
    // 这是区分“测量时机造成的假滞后”与“用户真实看到的滞后”的唯一可靠依据：
    //   window-resize 快照偏大但 post-paint 已贴底 → 绘制正确，之前的偏差只是采样时机；
    //   post-paint 也未贴底 → 真的晚一帧，需要改写入时机。
    const schedulePostPaintSnapshot = (): void => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (disposed) return
          logSnapshot('post-paint')
        })
      })
    }

    const handleResize = (): void => {
      if (!activeSession) {
        activeSession = true
        sessionId += 1
        scheduleSnapshot('resize-start')
      }
      scheduleSnapshot('window-resize')
      schedulePostPaintSnapshot()

      if (settleTimer !== null) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        activeSession = false
        scheduleSnapshot('resize-settled')
        settleTimer = null
      }, DIAGNOSTIC_SETTLE_TIMEOUT_MS)
    }

    const handleScroll = (): void => {
      if (activeSession) scheduleSnapshot('scroll')
    }

    const scrollResizeObserver = new ResizeObserver(() => {
      if (activeSession) scheduleSnapshot('scroll-region-resize')
    })
    scrollResizeObserver.observe(scrollElement)

    const composerResizeObserver = new ResizeObserver(() => {
      if (activeSession) scheduleSnapshot('composer-resize')
    })
    const composer = getComposer()
    if (composer) composerResizeObserver.observe(composer)

    window.addEventListener('resize', handleResize)
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    console.info('[CONVERSATION-SCROLL-DEBUG-SETUP] 已启用', {
      scrollAnchor,
      usage: '?conversationScrollDebug=1&conversationScrollAnchor=auto|none',
    })

    return () => {
      disposed = true
      window.removeEventListener('resize', handleResize)
      scrollElement.removeEventListener('scroll', handleScroll)
      scrollResizeObserver.disconnect()
      composerResizeObserver.disconnect()
      if (frameId !== null) cancelAnimationFrame(frameId)
      if (settleTimer !== null) clearTimeout(settleTimer)
    }
  }, [enabled, scrollAnchor, scrollRef])

  return null
}

// ===== ConversationEmptyState 空状态 =====

export interface ConversationEmptyStateProps extends ComponentProps<'div'> {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export function ConversationEmptyState({
  className,
  title = '暂无消息',
  description = '在下方输入框开始对话',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{title}</h3>
            {description && (
              <p className="text-muted-foreground text-sm">{description}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ===== ConversationScrollButton 滚动到底部 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export function ConversationScrollButton({
  className,
  ...props
}: ConversationScrollButtonProps): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  if (isAtBottom) return null

  return (
    <Button
      data-scroll-to-bottom
      className={cn(
        'absolute bottom-[26px] left-1/2 -translate-x-1/2 rounded-[17px] size-9',
        'border-[0.5px] border-border',
        className
      )}
      onClick={handleScrollToBottom}
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  )
}
