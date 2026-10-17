import * as React from 'react'
import { Bot } from 'lucide-react'
import type { AgentRuntime } from '@profer/shared'
import { AgentComposerToolMenuItem, AgentComposerToolPopover, AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'

const AGENT_RUNTIME_OPTIONS: Array<{ value: AgentRuntime; label: string; description: string }> = [
  { value: 'claude', label: 'Claude', description: '使用 Claude Agent SDK' },
  { value: 'pi', label: 'Pi', description: '使用 Pi Agent SDK' },
]

export function AgentRuntimeSelector({
  runtime,
  disabled,
  locked,
  onChange,
}: {
  runtime: AgentRuntime
  disabled: boolean
  locked: boolean
  onChange: (runtime: AgentRuntime) => void
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const current = AGENT_RUNTIME_OPTIONS.find((option) => option.value === runtime) ?? AGENT_RUNTIME_OPTIONS[0]!

  return (
    <AgentComposerToolPopover
      open={!locked && !disabled && open}
      onOpenChange={(nextOpen) => setOpen(disabled || locked ? false : nextOpen)}
      tooltip={locked ? `当前会话固定使用 ${current.label}；更换内核请新建会话` : disabled ? '正在保存内核选择或开始运行' : `选择本会话内核（当前：${current.label}），首次发送后固定`}
      align="start"
      className="w-48"
      trigger={
        <AgentComposerToolTrigger
          label={`Agent 内核：${current.label}`}
          disabled={disabled || locked}
          // 与模型选择器等「带文字工具」共用同一壳层尺寸约定：
          // 内核是会话级模式指示，必须能一眼分辨 Claude / Pi，不能只留图标。
          className="flex w-auto items-center gap-1.5 px-2 text-xs"
        >
          <Bot className="size-5 shrink-0" />
          <span className="truncate">{current.label}</span>
        </AgentComposerToolTrigger>
      }
    >
      {AGENT_RUNTIME_OPTIONS.map((option) => (
        <AgentComposerToolMenuItem
          key={option.value}
          selected={option.value === runtime}
          className="flex-col items-start px-2.5 py-2"
          onClick={() => { onChange(option.value); setOpen(false) }}
        >
          <span className="text-xs font-medium">{option.label}</span>
          <span className="mt-0.5 text-[11px] text-muted-foreground">{option.description}</span>
        </AgentComposerToolMenuItem>
      ))}
    </AgentComposerToolPopover>
  )
}

