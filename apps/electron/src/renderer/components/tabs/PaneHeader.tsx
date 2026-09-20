/**
 * PaneHeader — 组合 tab 的栏头
 *
 * 只在「组合 tab」激活时渲染，回答三个问题：这一栏是哪个会话、谁有焦点、这一栏怎么收起。
 *
 * 为什么需要它：被移除的旧分屏实现（commit 754ffda7b / PR #288）里，分屏面板只有
 * 一个 `rounded-lg border`，焦点靠 `border-primary/40` 表示，用户在两个面板之间
 * 分不清"我是谁、我在哪一栏"。栏头就是补上这层表达。
 *
 * 视觉分层：顶栏（37px Tab 内容行）> 右侧文件面板 Tab（40px）> 栏头（32px），
 * 高度梯度与浏览器标签行（32px）对齐，避免在主区里再出现第四套几何。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Blocks, BookOpen, Bot, Clock, FileText, MessageSquare, PanelRightClose, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TabType } from '@/atoms/tab-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { interfaceVariantAtom } from '@/atoms/theme'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SESSION_STATUS_DOT_CLASS, SESSION_STATUS_LABEL } from '@/lib/session-status-visual'
import type { TabGroupSide } from '@/atoms/tab-group-atoms'

/** 栏头高度：与浏览器标签行一致，压在顶栏（37px）与右侧文件面板 Tab（40px）之下形成稳定梯度 */
export const PANE_HEADER_HEIGHT = 32

function tabTypeIcon(type: TabType): React.ReactElement | null {
  switch (type) {
    case 'agent':
      return <Bot className="size-3.5 shrink-0" aria-hidden="true" />
    case 'chat':
      return <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
    case 'preview':
      return <FileText className="size-3.5 shrink-0" aria-hidden="true" />
    case 'tutorial':
      return <BookOpen className="size-3.5 shrink-0" aria-hidden="true" />
    case 'plugin':
      return <Blocks className="size-3.5 shrink-0" aria-hidden="true" />
    default:
      return null
  }
}

export interface PaneHeaderProps {
  /** 栏位：left = 左栏，right = 右栏 */
  pane: TabGroupSide
  type: TabType
  title: string
  status: SessionIndicatorStatus
  /** 该栏是否为当前焦点栏（焦点 = activeTabId 属于哪一侧） */
  focused: boolean
  /** 该栏标签是否由定时任务创建 */
  isAutomation?: boolean
  /** 聚焦该栏（点击栏头） */
  onFocus: () => void
  /** 左栏动作：解散组合（两个标签都保留） */
  onDissolveGroup?: () => void
  /** 右栏动作：关闭该栏标签（关闭后组合自动解散） */
  onClosePane?: () => void
}

export function PaneHeader({
  pane,
  type,
  title,
  status,
  focused,
  isAutomation = false,
  onFocus,
  onDissolveGroup,
  onClosePane,
}: PaneHeaderProps): React.ReactElement {
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const paneLabel = pane === 'left' ? '左栏' : '右栏'
  const statusLabel = SESSION_STATUS_LABEL[status]

  return (
    <div
      data-pane-header={pane}
      className={cn(
        'flex flex-shrink-0 items-center gap-1 px-2 titlebar-no-drag',
        focused
          ? 'bg-content-area border-b border-surface-border/40'
          : 'bg-surface-sunken/40 border-b border-surface-border/25',
        // classic 皮肤保留栏头与栏体的包裹感；modern 只用分割线区分层级
        isClassic && focused && 'shadow-[inset_0_1px_0_0_hsl(var(--border)/0.35)]',
      )}
      style={{ height: PANE_HEADER_HEIGHT }}
    >
      <button
        type="button"
        // 聚焦整栏：只有按钮承担点击，避免与内容区的 pointer 事件争抢（旧实现点空白才生效）
        aria-label={`聚焦${paneLabel}：${title}${statusLabel ? `（${statusLabel}）` : ''}`}
        aria-current={focused || undefined}
        onClick={onFocus}
        onPointerDown={onFocus}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs transition-colors',
          focused
            ? 'text-foreground'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
        )}
      >
        <span className={cn('flex-shrink-0', focused ? 'text-foreground/70' : 'text-muted-foreground/70')}>
          {tabTypeIcon(type)}
        </span>
        {isAutomation && <Clock className="size-3 shrink-0 text-foreground/40" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {status !== 'idle' && (
          <span
            className={cn('size-1.5 shrink-0 rounded-full', SESSION_STATUS_DOT_CLASS[status])}
            title={statusLabel}
            aria-hidden="true"
          />
        )}
      </button>

      {onDissolveGroup && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDissolveGroup}
              aria-label="解散组合"
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/75 transition-colors hover:bg-accent/70 hover:text-foreground"
            >
              <PanelRightClose className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>解散组合（两个标签都保留）</p>
          </TooltipContent>
        </Tooltip>
      )}

      {onClosePane && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClosePane}
              aria-label={`关闭${paneLabel}标签：${title}`}
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/75 transition-colors hover:bg-accent/70 hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>关闭该栏标签（退回单栏）</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
