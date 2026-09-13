/**
 * DiffPanelTabBar — 右侧面板顶部 Tab 栏
 *
 * 切换「会话文件」「工作区文件」和「代码改动」三个视图。最右侧有关闭按钮。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { PanelRightClose, Split } from 'lucide-react'
import { cn } from '@/lib/utils'
import { interfaceVariantAtom } from '@/atoms/theme'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { agentDiffUnseenChangesAtom, currentAgentSessionIdAtom, type AgentSidePanelTab } from '@/atoms/agent-atoms'

type DiffPanelTab = AgentSidePanelTab

interface DiffPanelTabBarProps {
  activeTab: DiffPanelTab
  onTabChange: (tab: DiffPanelTab) => void
  /** 当前父会话已打开的探索分支，按最近打开顺序追加在文件 Tab 后。 */
  explorationTabs?: Array<{ id: `exploration:${string}`; label: string }>
  /** 当前探索 Tab 的紧凑动作。 */
  activeTabAction?: React.ReactNode
  onClose?: () => void
}

interface PreviousTabState {
  sessionId: string | null
  activeTab: DiffPanelTab
}

export function DiffPanelTabBar({ activeTab, onTabChange, explorationTabs = [], activeTabAction, onClose }: DiffPanelTabBarProps): React.ReactElement {
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

  return (
    <div className="flex items-end h-[40px] tabbar-bg relative flex-shrink-0">
      <div className="absolute inset-0 titlebar-drag-region" />
      <div className="relative flex items-end flex-1 titlebar-no-drag">
        <button
          type="button"
          onClick={() => onTabChange('session')}
          className={cn(
            'flex-1 min-w-0 px-3 h-[40px] text-xs whitespace-nowrap overflow-hidden text-ellipsis transition-colors select-none cursor-pointer',
            'border-t border-l border-r',
            isClassic ? 'rounded-t-lg' : 'rounded-none',
            activeTab === 'session'
              ? isClassic ? 'bg-content-area text-foreground border-border/50' : 'app-tab-active text-foreground border-border/80'
              : isClassic ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50' : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
          )}
        >
          会话文件
        </button>
        <button
          type="button"
          onClick={() => onTabChange('workspace')}
          className={cn(
            'flex-1 min-w-0 px-3 h-[40px] text-xs whitespace-nowrap overflow-hidden text-ellipsis transition-colors select-none cursor-pointer',
            'border-t border-l border-r',
            isClassic ? 'rounded-t-lg' : 'rounded-none',
            activeTab === 'workspace'
              ? isClassic ? 'bg-content-area text-foreground border-border/50' : 'app-tab-active text-foreground border-border/80'
              : isClassic ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50' : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
          )}
        >
          工作区文件
        </button>
        <button
          type="button"
          onClick={handleChangesClick}
          className={cn(
            'flex-1 min-w-0 px-3 h-[40px] text-xs whitespace-nowrap overflow-hidden text-ellipsis transition-colors select-none cursor-pointer relative',
            'border-t border-l border-r',
            isClassic ? 'rounded-t-lg' : 'rounded-none',
            activeTab === 'changes'
              ? isClassic ? 'bg-content-area text-foreground border-border/50' : 'app-tab-active text-foreground border-border/80'
              : isClassic ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50' : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
          )}
        >
          <span className="inline-flex items-center gap-1">
            {unseenChanges && activeTab !== 'changes' && (
              <span className="size-2 rounded-full bg-primary ring-1 ring-background shrink-0" />
            )}
            文件改动
          </span>
        </button>
        {explorationTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'flex min-w-0 max-w-[160px] shrink-0 items-center gap-1 px-3 h-[40px] text-xs whitespace-nowrap overflow-hidden text-ellipsis transition-colors select-none cursor-pointer',
              'border-t border-l border-r',
              isClassic ? 'rounded-t-lg' : 'rounded-none',
              activeTab === tab.id
                ? isClassic ? 'bg-content-area text-foreground border-border/50' : 'app-tab-active text-foreground border-border/80'
                : isClassic ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50' : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
            )}
            title={tab.label}
          >
            <Split className="size-3 shrink-0" />
            <span className="truncate">{tab.label}</span>
          </button>
        ))}
        {activeTabAction && <div className="ml-1 flex shrink-0 items-center titlebar-no-drag">{activeTabAction}</div>}
        {/* 右侧关闭按钮（常驻，文件与探索 Tab 下都可见） */}
        {onClose && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center size-[32px] mr-1 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <PanelRightClose className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">折叠文件面板 ({navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
