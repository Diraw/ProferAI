import * as React from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleX, Pause, Play, Square, Target } from 'lucide-react'
import { useAtomValue } from 'jotai'
import type { AgentGoalState } from '@profer/shared'
import { agentGoalAtomFamily } from '@/atoms/goal-atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = { sessionId: string }

const labels: Record<AgentGoalState['status'], string> = {
  active: '执行中', paused: '已暂停', completed: '已完成', blocked: '等待处理', failed: '执行失败', stopped: '已停止',
}

/** 语义色只给状态，面板本体保持中性 */
const statusTone: Record<AgentGoalState['status'], string> = {
  active: 'text-primary',
  paused: 'text-muted-foreground',
  completed: 'text-emerald-500',
  blocked: 'text-amber-500',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
}

function GoalIcon({ status }: { status: AgentGoalState['status'] }): React.ReactElement {
  const cls = cn('size-3.5', statusTone[status], status === 'active' && 'animate-pulse')
  if (status === 'blocked') return <AlertTriangle className={cls} aria-hidden="true" />
  if (status === 'completed') return <Check className={cls} aria-hidden="true" />
  if (status === 'failed') return <CircleX className={cls} aria-hidden="true" />
  return <Target className={cls} aria-hidden="true" />
}

/** 计时只在执行中推进；暂停/终态冻结在最后一次状态变化时刻 */
function useGoalElapsed(goal: AgentGoalState | undefined): number {
  const [now, setNow] = React.useState(() => Date.now())
  const active = goal?.status === 'active'
  React.useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  if (!goal) return 0
  const end = active ? now : goal.updatedAt
  return Math.max(0, end - goal.startedAt)
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? `${seconds % 60}s` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="shrink-0 text-[10px] text-muted-foreground/70 w-14 text-right">{label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={value}>{value}</span>
    </div>
  )
}

export function GoalStatusBar({ sessionId }: Props): React.ReactElement | null {
  const goal = useAtomValue(agentGoalAtomFamily(sessionId))
  const [expanded, setExpanded] = React.useState(false)
  const elapsed = useGoalElapsed(goal)
  if (!goal) return null

  const invoke = (action: 'pause' | 'resume' | 'stop') => window.electronAPI[`${action}Goal`](sessionId).catch(console.error)
  const hasDetails = Boolean(
    goal.contract?.verification || goal.contract?.constraints || goal.contract?.stopWhen
    || goal.lastSummary || (goal.lastEvidence?.length ?? 0) > 0
    || (goal.stopReason && goal.stopReason !== 'app_restart'),
  )
  const controllable = goal.status === 'active' || goal.status === 'paused'

  return (
    <div className="px-3 pt-2" data-testid="goal-status-bar">
      <div className="rounded-lg border border-border/60 bg-muted/30 shadow-sm">
        {/* 主行：状态 + 目标 + 元信息 + 控制 */}
        <div className="flex items-center gap-2.5 px-3 h-9">
          <GoalIcon status={goal.status} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={goal.goal}>{goal.goal}</span>
          <span className={cn('shrink-0 text-[11px] font-medium', statusTone[goal.status])} role="status">
            {labels[goal.status]}{goal.stopReason === 'app_restart' ? ' · 重启后待恢复' : ''}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title={goal.status === 'active' ? '已运行时长' : '总用时（已冻结）'}>
            第 {goal.iteration} 轮 · {formatElapsed(elapsed)}
          </span>
          {hasDetails && (
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" title={expanded ? '收起详情' : '查看契约与进展'} onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </Button>
          )}
          {goal.status === 'active' && (
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-foreground" title="暂停 Goal" onClick={() => invoke('pause')}>
              <Pause className="size-3" />
            </Button>
          )}
          {goal.status === 'paused' && (
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-foreground" title="恢复 Goal" onClick={() => invoke('resume')}>
              <Play className="size-3" />
            </Button>
          )}
          {controllable && (
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-destructive" title="停止 Goal" onClick={() => invoke('stop')}>
              <Square className="size-3" />
            </Button>
          )}
        </div>
        {/* 详情区：契约与最近进展 */}
        {expanded && hasDetails && (
          <div className="flex flex-col gap-1 border-t border-border/40 px-3 py-2 text-[11px]">
            {goal.contract?.verification && <DetailRow label="验收" value={goal.contract.verification} />}
            {goal.contract?.constraints && <DetailRow label="约束" value={goal.contract.constraints} />}
            {goal.contract?.stopWhen && <DetailRow label="停止条件" value={goal.contract.stopWhen} />}
            {goal.lastSummary && <DetailRow label="最近进展" value={goal.lastSummary} />}
            {goal.usage && <DetailRow label="用量" value={`${goal.usage.totalTokens.toLocaleString()} tokens（输入 ${goal.usage.inputTokens.toLocaleString()} · 输出 ${goal.usage.outputTokens.toLocaleString()}）`} />}
            {(goal.lastEvidence?.length ?? 0) > 0 && <DetailRow label="证据" value={goal.lastEvidence!.join('；')} />}
            {goal.stopReason && goal.stopReason !== 'app_restart' && <DetailRow label="原因" value={goal.stopReason} />}
          </div>
        )}
      </div>
    </div>
  )
}
