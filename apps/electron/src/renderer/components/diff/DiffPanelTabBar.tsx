/**
 * DiffPanelTabBar — 右侧面板顶部 Tab 栏
 *
 * 切换「会话文件」「工作区文件」和「代码改动」三个视图。最右侧有关闭按钮。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FileDiff, FolderOpen, FolderTree, PanelRightClose, Split, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { interfaceVariantAtom } from '@/atoms/theme'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { agentDiffUnseenChangesAtom, currentAgentSessionIdAtom, type AgentSidePanelTab, type SessionIndicatorStatus } from '@/atoms/agent-atoms'

type DiffPanelTab = AgentSidePanelTab

interface DiffPanelTabBarProps {
  activeTab: DiffPanelTab
  onTabChange: (tab: DiffPanelTab) => void
  /** 当前父会话已打开的探索分支，按最近打开顺序追加在文件 Tab 后。 */
  explorationTabs?: Array<{ id: `exploration:${string}`; label: string; status: SessionIndicatorStatus }>
  onCloseExplorationTab?: (tab: `exploration:${string}`) => void
  onClose?: () => void
}

interface PreviousTabState {
  sessionId: string | null
  activeTab: DiffPanelTab
}

/**
 * 文件视图单个 Tab。
 *
 * 两种形态：
 * - 常规（无探索分支）：文字 Tab，flex-1 平分整行宽度。
 * - 紧凑（有探索分支）：图标 Tab，固定窄宽，把剩余宽度让给探索分支 Tab 自适应伸展；
 *   此时文字语义由 tooltip 与 aria-label 承载。
 */
function FileViewTabButton({
  active,
  isClassic,
  label,
  icon,
  onClick,
  compact = false,
  badge = false,
}: {
  active: boolean
  isClassic: boolean
  label: string
  icon: React.ReactNode
  onClick: () => void
  compact?: boolean
  /** 待查看标记：文字形态在标签前，图标形态在图标右上角 */
  badge?: boolean
}): React.ReactElement {
  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'relative flex items-center h-[40px] text-xs transition-colors select-none cursor-pointer',
        'border-t border-l border-r',
        isClassic ? 'rounded-t-lg' : 'rounded-none',
        compact
          ? 'w-11 shrink-0 justify-center'
          : 'min-w-0 flex-1 justify-center gap-1 overflow-hidden px-3',
        active
          ? isClassic ? 'bg-content-area text-foreground border-border/50' : 'app-tab-active text-foreground border-border/80'
          : isClassic ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50' : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
      )}
    >
      {compact ? (
        <>
          {icon}
          {badge && (
            <span className="absolute right-2.5 top-2 size-1.5 rounded-full bg-primary ring-1 ring-background" />
          )}
        </>
      ) : (
        <>
          {badge && <span className="size-2 shrink-0 rounded-full bg-primary ring-1 ring-background" />}
          <span className="truncate">{label}</span>
        </>
      )}
    </button>
  )

  // 仅图标形态需要 tooltip 解释语义；文字形态自带标签
  if (!compact) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

export function DiffPanelTabBar({ activeTab, onTabChange, explorationTabs = [], onCloseExplorationTab, onClose }: DiffPanelTabBarProps): React.ReactElement {
  const unseenMap = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenMap = useSetAtom(agentDiffUnseenChangesAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const unseenChanges = unseenMap.get(currentSessionId ?? '') ?? false
  const prevTabStateRef = React.useRef<PreviousTabState>({ sessionId: currentSessionId, activeTab })

  const clearUnseen = React.useCallback((sessionId = currentSessionId) => {
    if (!sessionId) return
    setUnseenMap((prev) => {
      if (prev.get(sessionId) === false) return prev
      const m = new Map(prev)
      m.set(sessionId, false)
      return m
    })
  }, [currentSessionId, setUnseenMap])

  // 同一会话内，从「文件改动」切走时，说明用户已经看过当前改动。
  React.useEffect(() => {
    const previous = prevTabStateRef.current
    if (previous.sessionId === currentSessionId && previous.activeTab === 'changes' && activeTab !== 'changes') {
      clearUnseen(currentSessionId)
    }
    prevTabStateRef.current = { sessionId: currentSessionId, activeTab }
  }, [activeTab, currentSessionId, clearUnseen])

  const handleChangesClick = () => {
    clearUnseen()
    if (activeTab !== 'changes') {
      onTabChange('changes')
    }
  }

  // 有探索分支时，文件视图 Tab 收成图标，把整行剩余宽度让给探索 Tab 自适应伸展。
  const hasExplorationTabs = explorationTabs.length > 0

  return (
    <div className="flex items-end h-[40px] tabbar-bg relative flex-shrink-0">
      <div className="absolute inset-0 titlebar-drag-region" />
      <div className="relative flex min-w-0 items-end flex-1 titlebar-no-drag overflow-x-auto scrollbar-none">
        <FileViewTabButton
          active={activeTab === 'session'}
          isClassic={isClassic}
          label="会话文件"
          icon={<FolderOpen className="size-3.5" />}
          compact={hasExplorationTabs}
          onClick={() => onTabChange('session')}
        />
        <FileViewTabButton
          active={activeTab === 'workspace'}
          isClassic={isClassic}
          label="工作区文件"
          icon={<FolderTree className="size-3.5" />}
          compact={hasExplorationTabs}
          onClick={() => onTabChange('workspace')}
        />
        <FileViewTabButton
          active={activeTab === 'changes'}
          isClassic={isClassic}
          label="文件改动"
          icon={<FileDiff className="size-3.5" />}
          compact={hasExplorationTabs}
          badge={unseenChanges && activeTab !== 'changes'}
          onClick={handleChangesClick}
        />
        {explorationTabs.map((tab) => (
          <div
            key={tab.id}
            className="group relative flex min-w-[140px] flex-1 items-center"
            onMouseDown={(event) => {
              // 中键关闭：与顶部会话标签、浏览器标签同一交互约定。
              // 绑在容器上，中键点 Tab 主体或右侧关闭钮均可关闭。
              if (event.button === 1) {
                event.preventDefault()
                onCloseExplorationTab?.(tab.id)
              }
            }}
          >
            <button
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={cn(
                'flex min-w-0 w-full items-center gap-1.5 pl-3 pr-8 h-[40px] text-xs whitespace-nowrap overflow-hidden text-ellipsis transition-colors select-none cursor-pointer',
                'border-t border-l border-r',
                isClassic ? 'rounded-t-lg' : 'rounded-none',
                activeTab === tab.id
                  ? isClassic ? 'bg-content-area text-foreground border-border/50' : 'app-tab-active text-foreground border-border/80'
                  : isClassic ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50' : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
              )}
              title={tab.label}
            >
              <span className={cn(
                'size-1.5 shrink-0 rounded-full',
                tab.status === 'running' && 'bg-sky-500 animate-pulse',
                tab.status === 'blocked' && 'bg-amber-500',
                tab.status === 'completed' && 'bg-emerald-500',
                tab.status === 'idle' && 'bg-transparent',
              )} />
              <Split className="size-3 shrink-0" />
              <span className="truncate">{tab.label}</span>
            </button>
            {onCloseExplorationTab && (
              <button
                type="button"
                aria-label={`关闭探索分支：${tab.label}`}
                title="关闭探索 Tab"
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseExplorationTab(tab.id)
                }}
                className="absolute right-1 flex size-6 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      {/* 折叠钮始终固定在右侧，不随大量探索 Tab 横向滚走。 */}
      {onClose && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClose}
              className="relative flex items-center justify-center size-[32px] mr-1 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0 titlebar-no-drag"
            >
              <PanelRightClose className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">折叠右侧工作区 ({navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
