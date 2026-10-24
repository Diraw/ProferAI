/**
 * 推理强度面板 + 触发按钮标签。
 *
 * 位置：模型弹层里的二级视图——点模型列表底部的「推理强度」进入，返回键回到模型列表。
 *
 * 为什么是列表而不是滑条：档位是离散且语义不同的选项，「关闭」不是「最小」而是另一种
 * 模式；GLM-5.3 只有「关闭 / 高」两档，滑条会退化成开关。列表还能给每个档位放一句说明。
 *
 * 「跟随预设」是列表里的第一项：选中它 = 清除会话覆盖，选具体档位 = 写入覆盖，
 * 两个方向都是一次点击，不需要先回退再选。
 */
import * as React from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@profer/ui/primitives/switch'
import type {
  AgentEffort,
  AgentSessionMeta,
  AgentThinkingLevel,
  ReasoningCapability,
  ThinkingConfig,
} from '@profer/shared'
import { normalizeReasoningCapabilityLevel } from '@profer/shared'
import { cn } from '@/lib/utils'
import { updateComposerEffort, updateComposerOpenAIThinkingLevel } from '@/domains/composer/composer-api'

/** 档位文案统一表：xhigh 与 max 必须可区分，避免「最高 / 最大」并排时无法理解。 */
export const THINKING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最高',
}

export const EFFORT_LABELS: Record<AgentEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
}

/** 没有 capability 时（Claude 内核）可选的强度档。 */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly AgentEffort[]

/** 「跟随预设」选项的键；与真实档位区分，写入时翻译成 null。 */
export const DEFAULT_REASONING_OPTION = '__default__'

export interface ReasoningOption {
  value: AgentThinkingLevel | AgentEffort | typeof DEFAULT_REASONING_OPTION
  label: string
  /** 右侧补充说明，只给语义不直观的档位（如「关闭」）。 */
  hint?: string
  isDefault: boolean
}

export interface AgentReasoningPanelProps {
  sessionId: string
  /** Pi + 已知模型能力时提供；缺省走 Claude 的 adaptive + 强度档。 */
  capability?: ReasoningCapability
  /** 正在拉取模型 capability：先显示占位，不要闪回 Claude 强度档。 */
  loading?: boolean
  /** 会话级 Pi 档位覆盖；null/undefined 表示跟随预设 / 全局默认。 */
  sessionLevel?: AgentThinkingLevel | null
  /** 会话级强度覆盖（Claude 分支）。 */
  sessionEffort?: AgentEffort | null
  /** 预设声明的强度，作为无会话覆盖时的默认档。 */
  presetEffort?: AgentEffort
  /** 全局强度设置，作为预设未声明时的兜底。 */
  globalEffort?: AgentEffort
  agentThinking?: ThinkingConfig
  onToggleThinking: () => void
  /** Agent 运行中：模型已锁定，但档位仍可改、下一轮生效。 */
  running: boolean
  onSessionUpdated: (session: AgentSessionMeta) => void
  thinkingExpanded: boolean
  onThinkingExpandedChange: (next: boolean) => void
}

/** 触发按钮与入口行共用的摘要。 */
export interface ReasoningChipState {
  label: string
  /** true 表示当前值来自默认级联，而不是会话覆盖。 */
  muted: boolean
  /** 来源说明，如「跟随预设「高」」「本会话覆盖」。 */
  sourceText: string
}

export function resolveReasoningChipState(input: {
  capability?: ReasoningCapability
  sessionLevel?: AgentThinkingLevel | null
  sessionEffort?: AgentEffort | null
  presetEffort?: AgentEffort
  globalEffort?: AgentEffort
  agentThinking?: ThinkingConfig
}): ReasoningChipState {
  const { capability, sessionLevel, sessionEffort, presetEffort, globalEffort, agentThinking } = input
  const fallbackEffort = presetEffort ?? globalEffort ?? 'high'

  if (capability && capability.levels.length > 0) {
    // 会话档位可能来自上一个模型（如 DeepSeek 的 max），切到只支持 off/high 的模型时
    // 必须按新 capability 收敛后再算标签，否则 chip 会显示一个选不中的档。
    const requested = sessionLevel ?? fallbackEffort
    const resolved = normalizeReasoningCapabilityLevel(capability, requested) ?? capability.defaultLevel
    const defaultLevel = normalizeReasoningCapabilityLevel(capability, fallbackEffort) ?? capability.defaultLevel
    const overridden = sessionLevel != null
    return {
      label: THINKING_LEVEL_LABELS[resolved],
      muted: !overridden,
      sourceText: overridden
        ? '本会话覆盖'
        : `跟随${presetEffort ? '预设' : '全局'}「${THINKING_LEVEL_LABELS[defaultLevel]}」`,
    }
  }

  if (agentThinking?.type !== 'adaptive') {
    return { label: '关闭', muted: true, sourceText: '思考已关闭' }
  }
  const overridden = sessionEffort != null
  return {
    label: EFFORT_LABELS[sessionEffort ?? fallbackEffort],
    muted: !overridden,
    sourceText: overridden
      ? '本会话覆盖'
      : `跟随${presetEffort ? '预设' : '全局'}「${EFFORT_LABELS[fallbackEffort]}」`,
  }
}

/**
 * 面板里的选项列表：第一项永远是「跟随预设」，其余是模型支持的档位。
 * 默认项带上它当前解析到的值，用户不用去别处确认继承的是什么。
 */
export function resolveReasoningOptions(input: {
  capability?: ReasoningCapability
  presetEffort?: AgentEffort
  globalEffort?: AgentEffort
}): ReasoningOption[] {
  const { capability, presetEffort, globalEffort } = input
  const fallbackEffort = presetEffort ?? globalEffort ?? 'high'

  if (capability && capability.levels.length > 0) {
    const resolved = normalizeReasoningCapabilityLevel(capability, fallbackEffort) ?? capability.defaultLevel
    return [
      { value: DEFAULT_REASONING_OPTION, label: '跟随预设', hint: THINKING_LEVEL_LABELS[resolved], isDefault: true },
      ...capability.levels.map((level) => ({
        value: level,
        label: THINKING_LEVEL_LABELS[level],
        hint: level === 'off' ? '不产出思考' : undefined,
        isDefault: false,
      })),
    ]
  }

  return [
    { value: DEFAULT_REASONING_OPTION, label: '跟随预设', hint: EFFORT_LABELS[fallbackEffort], isDefault: true },
    ...CLAUDE_EFFORT_LEVELS.map((effort) => ({
      value: effort,
      label: EFFORT_LABELS[effort],
      isDefault: false,
    })),
  ]
}

/** 触发按钮上的档位标签。muted 表示当前值来自默认级联而非会话覆盖。 */
export function AgentReasoningChip({ state }: { state: ReasoningChipState }): React.ReactElement {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-4',
        state.muted
          ? 'border border-border/70 text-muted-foreground'
          : 'bg-muted font-medium text-foreground/80',
      )}
    >
      {state.label}
    </span>
  )
}

/** 模型菜单底部的一行入口。点它切到推理强度面板。 */
export function AgentReasoningEntry({
  state,
  disabled,
  onOpen,
}: {
  state: ReasoningChipState
  disabled?: boolean
  onOpen: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors',
        'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        disabled && 'cursor-not-allowed opacity-45',
      )}
    >
      <span className="text-[11px] text-muted-foreground">推理强度</span>
      <span className="ml-auto truncate text-[11.5px] text-foreground/80">{state.label}</span>
      <span className="shrink-0 text-[10.5px] text-muted-foreground">· {state.sourceText}</span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  )
}

export function AgentReasoningPanel({
  sessionId,
  capability,
  loading = false,
  sessionLevel,
  sessionEffort,
  presetEffort,
  globalEffort,
  agentThinking,
  onToggleThinking,
  running,
  onSessionUpdated,
  thinkingExpanded,
  onThinkingExpandedChange,
}: AgentReasoningPanelProps): React.ReactElement {
  const hasCapability = Boolean(capability && capability.levels.length > 0)
  const pending = loading && !hasCapability

  const defaultLevel = capability
    ? normalizeReasoningCapabilityLevel(capability, presetEffort ?? globalEffort ?? 'high') ?? capability.defaultLevel
    : undefined
  const activeLevel = capability && (sessionLevel ?? defaultLevel)
    ? normalizeReasoningCapabilityLevel(capability, sessionLevel ?? defaultLevel) ?? capability.defaultLevel
    : (sessionLevel ?? defaultLevel)
  const activeEffort = sessionEffort ?? presetEffort ?? globalEffort ?? 'high'
  const thinkingEnabled = agentThinking?.type === 'adaptive'

  const overridden = hasCapability ? sessionLevel != null : sessionEffort != null
  const levelClamped = Boolean(capability && sessionLevel && activeLevel && sessionLevel !== activeLevel)

  const options = resolveReasoningOptions({ capability, presetEffort, globalEffort })
  const [saving, setSaving] = React.useState(false)

  const apply = React.useCallback(async (
    action: () => Promise<AgentSessionMeta>,
    successMessage: string,
  ): Promise<void> => {
    setSaving(true)
    try {
      const updated = await action()
      onSessionUpdated(updated)
      toast.success(successMessage)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换推理强度失败')
    } finally {
      setSaving(false)
    }
  }, [onSessionUpdated])

  const handleSelect = (option: ReasoningOption): void => {
    if (saving) return

    if (option.isDefault) {
      if (!overridden) return
      void apply(
        hasCapability
          ? () => updateComposerOpenAIThinkingLevel(sessionId, null)
          : () => updateComposerEffort(sessionId, null),
        '已恢复默认推理强度',
      )
      return
    }

    if (hasCapability) {
      const level = option.value as AgentThinkingLevel
      void apply(
        () => updateComposerOpenAIThinkingLevel(sessionId, level),
        `推理档位已设为「${THINKING_LEVEL_LABELS[level]}」`,
      )
      return
    }

    const effort = option.value as AgentEffort
    void apply(
      () => updateComposerEffort(sessionId, effort),
      `思考强度已设为「${EFFORT_LABELS[effort]}」`,
    )
  }

  const sentValue = hasCapability && activeLevel ? capability?.effortMap?.[activeLevel] : undefined
  const note = ((): { text: string; tone: 'muted' | 'warning' } => {
    if (pending) return { text: '正在读取该模型的推理档位…', tone: 'muted' }
    if (hasCapability) {
      if (levelClamped && sessionLevel && activeLevel) {
        return {
          text: `「${THINKING_LEVEL_LABELS[sessionLevel]}」在本模型上收敛为「${THINKING_LEVEL_LABELS[activeLevel]}」`,
          tone: 'warning',
        }
      }
      if (running) return { text: '运行中 · 改动下一轮生效', tone: 'warning' }
      if (typeof sentValue === 'string' && sentValue !== activeLevel) {
        return { text: `该档位实际发送 ${sentValue}`, tone: 'muted' }
      }
      return { text: '档位越高，思考越久、消耗越多', tone: 'muted' }
    }
    if (!thinkingEnabled) return { text: '思考已关闭，模型不会产出思考内容', tone: 'muted' }
    if (running) return { text: '运行中 · 改动下一轮生效', tone: 'warning' }
    return { text: '档位越高，思考越久、消耗越多', tone: 'muted' }
  })()

  return (
    <div className="flex flex-col">
      {!hasCapability && !pending ? (
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          <span className="text-[13px] text-foreground/80">思考模式</span>
          <Switch
            checked={thinkingEnabled}
            onCheckedChange={onToggleThinking}
            className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
          />
        </div>
      ) : null}

      <div className="p-1.5 pt-1">
        {pending ? (
          <div className="space-y-1.5 px-2 py-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-7 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : (
          <>
            {options.slice(0, 1).map((option) => (
              <ReasoningRow
                key={String(option.value)}
                option={option}
                checked={!overridden}
                disabled={saving}
                onSelect={() => handleSelect(option)}
              />
            ))}
            <div className="px-2 pb-1 pt-2 text-[10px] text-muted-foreground">具体档位</div>
            {options.slice(1).map((option) => (
              <ReasoningRow
                key={String(option.value)}
                option={option}
                checked={hasCapability
                  ? option.value === activeLevel
                  : option.value === activeEffort}
                disabled={saving || (!hasCapability && !thinkingEnabled)}
                onSelect={() => handleSelect(option)}
              />
            ))}
          </>
        )}
      </div>

      <div className="border-t border-border/50 px-4 py-2">
        <label className="flex cursor-pointer items-center justify-between gap-4">
          <span className="text-[11px] text-foreground/70">展开思考</span>
          <Switch
            checked={thinkingExpanded}
            onCheckedChange={onThinkingExpandedChange}
            className="h-4 w-7 [&>span]:size-3 [&>span]:data-[state=checked]:translate-x-3"
          />
        </label>
        <p
          className={cn(
            'mt-1 text-[10.5px] leading-4',
            note.tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}
        >
          {note.text}
        </p>
      </div>
    </div>
  )
}

function ReasoningRow({
  option,
  checked,
  disabled,
  onSelect,
}: {
  option: ReasoningOption
  checked: boolean
  disabled: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        checked ? 'text-foreground' : 'text-foreground/70',
        disabled && 'cursor-not-allowed opacity-45',
      )}
    >
      <span className="flex w-4 shrink-0 justify-center text-primary">
        {checked ? <Check className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{option.label}</span>
      {option.hint ? (
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">{option.hint}</span>
      ) : null}
    </button>
  )
}
