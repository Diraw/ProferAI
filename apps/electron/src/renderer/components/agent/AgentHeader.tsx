/**
 * AgentHeader — Agent 会话探索入口。
 *
 * 会话标题已经收敛到顶部 TabBar；这里保留一个轻量探索菜单，
 * 让关闭右侧 Tab 后仍可从持久化 session 元数据重新打开分支。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { PluginTaskControls } from '@/components/plugins/PluginTaskControls'
import { Split } from 'lucide-react'
import { agentDiffPanelTabAtom, agentSessionsAtom, agentSideExplorationMapAtom, agentSidePanelOpenAtom, getExplorationSidePanelTab } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface AgentHeaderProps {
  sessionId: string
}

export function AgentHeader({ sessionId }: AgentHeaderProps): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const setExplorationMap = useSetAtom(agentSideExplorationMapAtom)
  const setPanelOpen = useSetAtom(agentSidePanelOpenAtom)
  const setPanelTab = useSetAtom(agentDiffPanelTabAtom)
  const branches = React.useMemo(
    () => sessions
      .filter((session) => session.explorationParentSessionId === sessionId && !!session.explorationSourceMessageId)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessionId, sessions],
  )

  const reopen = React.useCallback((branch: (typeof branches)[number]): void => {
    if (!branch.explorationSourceMessageId) return
    setExplorationMap((previous) => {
      const openBranches = previous.get(sessionId) ?? []
      if (openBranches.some((item) => item.sessionId === branch.id)) return previous
      const next = new Map(previous)
      next.set(sessionId, [...openBranches, {
        sessionId: branch.id,
        sourceMessageId: branch.explorationSourceMessageId!,
        sourceLabel: branch.explorationSourceLabel ?? '主线探索节点',
      }])
      return next
    })
    setPanelOpen(true)
    setPanelTab((previous) => new Map(previous).set(sessionId, getExplorationSidePanelTab(branch.id)))
  }, [sessionId, setExplorationMap, setPanelOpen, setPanelTab])

  if (branches.length === 0) return <PluginTaskControls kind="agent" sessionId={sessionId} />

  return (
    <div className="flex flex-wrap items-center gap-2">
    <PluginTaskControls kind="agent" sessionId={sessionId} />
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="titlebar-no-drag h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground" aria-label={`打开 ${branches.length} 个探索分支`}>
          <Split className="size-3.5" />
          <span>探索</span>
          {branches.length > 1 && <span className="tabular-nums">{branches.length}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[100] w-64 titlebar-no-drag">
        {branches.map((branch) => (
          <DropdownMenuItem key={branch.id} onSelect={() => reopen(branch)} className="flex items-center gap-2 py-2">
            <Split className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{branch.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
  )
}
