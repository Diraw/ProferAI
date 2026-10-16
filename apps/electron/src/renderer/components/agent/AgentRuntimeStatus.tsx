import * as React from 'react'
import { Spinner } from '@profer/ui/primitives/spinner'
import type { AgentRuntimeDisplay } from '@/domains/agent-runtime/agent-runtime-display-policy'

/** 一条活跃状态行；长文案可折行，不改变消息分组与滚动容器。 */
export function AgentRuntimeStatus({ display }: { display: AgentRuntimeDisplay }): React.ReactElement | null {
  if (!display.label) return null
  return <div className="flex min-h-[28px] min-w-0 items-center gap-2" data-runtime-status={display.kind} role="status">
    <Spinner size="sm" aria-hidden="true" className="shrink-0 text-muted-foreground/60" />
    <span className="min-w-0 break-words text-[13px] font-light text-muted-foreground/75">{display.label}</span>
  </div>
}
