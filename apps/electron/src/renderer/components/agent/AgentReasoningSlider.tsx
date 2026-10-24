/**
 * 思考强度极简磁吸滑块 (AgentReasoningSlider)
 *
 * 遵循 Profer 设计系统规范：
 * 1. 采用语义化 token（bg-muted/bg-accent/text-foreground/border-border/bg-primary），完美支持深浅主题。
 * 2. 真实平滑拖动（Pointer Capture）+ 释放磁吸（Snap）。
 * 3. 完美的圆角比例（h-[26px] 轨道 + size-[22px] 实体滑块，内留白 2px，严格同心）。
 * 4. 极致克制的高级动效：去除低俗的呼吸闪烁，拉到极限档位时使用实体饱满主色与克制高光光晕。
 * 5. 动态自适应不同模型档位（2档、3档、4档、7档等均匀分布）。
 */

import * as React from 'react'
import type {
  AgentEffort,
  AgentThinkingLevel,
  ReasoningCapability,
} from '@profer/shared'
import { normalizeReasoningCapabilityLevel } from '@profer/shared'
import { cn } from '@/lib/utils'

export const THINKING_LEVEL_TITLES: Record<AgentThinkingLevel, string> = {
  off: '关闭',
  minimal: '极简',
  low: '轻度',
  medium: '中度',
  high: '深度',
  xhigh: '极深',
  max: '极限',
}

export const EFFORT_TITLES: Record<AgentEffort, string> = {
  low: '轻度',
  medium: '中度',
  high: '深度',
  max: '极限',
}

export const REASONING_DESCRIPTIONS: Record<string, string> = {
  off: '不生成思考，响应最快',
  minimal: '极简思考，适合简单快速指令',
  low: '轻度思考，适合常规问答与润色',
  medium: '适度思考，兼顾推理质量与速度',
  high: '深度推理，适合复杂代码与逻辑构思（推荐）',
  xhigh: '极深思考，适合攻坚难题与跨模块架构',
  max: '极限推理，耗尽算力追求最优解',
}

export interface AgentReasoningSliderProps {
  capability?: ReasoningCapability
  sessionLevel?: AgentThinkingLevel | null
  sessionEffort?: AgentEffort | null
  presetEffort?: AgentEffort
  globalEffort?: AgentEffort
  disabled?: boolean
  onChange: (value: AgentThinkingLevel | AgentEffort | null) => void
  onHoverLevelChange?: (level: AgentThinkingLevel | AgentEffort | null) => void
}

export function AgentReasoningSlider({
  capability,
  sessionLevel,
  sessionEffort,
  presetEffort,
  globalEffort,
  disabled = false,
  onChange,
  onHoverLevelChange,
}: AgentReasoningSliderProps): React.ReactElement {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const isDraggingRef = React.useRef(false)

  const hasCapability = Boolean(capability && capability.levels.length > 0)
  const fallbackEffort = presetEffort ?? globalEffort ?? 'high'

  // 模型实际支持的档位序列
  const levels = React.useMemo<(AgentThinkingLevel | AgentEffort)[]>(() => {
    if (hasCapability && capability) {
      return [...capability.levels]
    }
    return ['low', 'medium', 'high', 'max']
  }, [hasCapability, capability])

  const inheritedValue = React.useMemo(() => {
    if (hasCapability && capability) {
      return normalizeReasoningCapabilityLevel(capability, fallbackEffort) ?? capability.defaultLevel
    }
    return fallbackEffort
  }, [hasCapability, capability, fallbackEffort])

  const isOverridden = hasCapability ? sessionLevel != null : sessionEffort != null
  const activeValue = isOverridden
    ? (hasCapability ? sessionLevel! : sessionEffort!)
    : inheritedValue

  const activeIndex = Math.max(0, levels.indexOf(activeValue))
  const totalSteps = levels.length

  // 拖拽过程中的实时预览步进
  const [dragIndex, setDragIndex] = React.useState<number | null>(null)
  const currentIndex = dragIndex !== null ? dragIndex : activeIndex

  const currentLevel = levels[currentIndex]
  const isMaxTier = currentLevel === 'max' || currentLevel === 'xhigh'

  // 相对比例（0 ~ 1）
  const ratio = totalSteps > 1 ? currentIndex / (totalSteps - 1) : 1

  const calculateIndexFromPointer = React.useCallback(
    (clientX: number): number => {
      if (!trackRef.current) return currentIndex
      const rect = trackRef.current.getBoundingClientRect()
      const rawRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const nearest = Math.round(rawRatio * (totalSteps - 1))
      return Math.max(0, Math.min(totalSteps - 1, nearest))
    },
    [currentIndex, totalSteps]
  )

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || totalSteps <= 1) return
    e.preventDefault()
    isDraggingRef.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const newIdx = calculateIndexFromPointer(e.clientX)
    setDragIndex(newIdx)
    onHoverLevelChange?.(levels[newIdx] ?? null)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || disabled) return
    const newIdx = calculateIndexFromPointer(e.clientX)
    if (newIdx !== dragIndex) {
      setDragIndex(newIdx)
      onHoverLevelChange?.(levels[newIdx] ?? null)
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    const finalIdx = calculateIndexFromPointer(e.clientX)
    setDragIndex(null)
    onHoverLevelChange?.(null)
    const targetLvl = levels[finalIdx]
    if (targetLvl && (targetLvl !== inheritedValue || isOverridden)) {
      onChange(targetLvl)
    }
  }

  return (
    <div className="px-2.5 py-1.5 select-none">
      {/* 轨道：采用 Profer 语义化背景 bg-muted/80，高度 26px，内留白 2px，滑块 22px */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          isDraggingRef.current = false
          setDragIndex(null)
          onHoverLevelChange?.(null)
        }}
        className={cn(
          'relative h-[26px] w-full rounded-full bg-muted/80 p-[2px] flex items-center cursor-pointer touch-none select-none overflow-hidden',
          'border border-border/50 transition-colors',
          disabled && 'cursor-not-allowed'
        )}
      >
        {/* 高亮填充区域 */}
        <div
          className={cn(
            'absolute left-[2px] top-[2px] bottom-[2px] rounded-full transition-all ease-out pointer-events-none',
            isDraggingRef.current ? 'duration-75' : 'duration-200',
            activeValue === 'off' && currentIndex === 0
              ? 'bg-transparent'
              : 'bg-primary'
          )}
          style={{
            width: activeValue === 'off' && currentIndex === 0
              ? '0px'
              : `calc(${ratio * 100}% - ${ratio * 26}px + 11px)`,
          }}
        />

        {/* 刻度吸附小点：内边距与滑块圆心行程一致（2px 轨道内边距 + 11px 半径），拉到两端时点与圆纽同心。 */}
        <div className="absolute inset-0 flex items-center justify-between px-[13px] pointer-events-none">
          {levels.map((lvl, idx) => {
            const isThumb = idx === currentIndex
            const isLeft = idx < currentIndex
            return (
              <div
                key={lvl}
                className={cn(
                  'size-1 rounded-full transition-all duration-150',
                  isThumb
                    ? 'opacity-0 scale-50'
                    : isLeft
                      ? 'bg-primary-foreground/85 scale-100'
                      : 'bg-foreground/25 scale-90'
                )}
              />
            )
          })}
        </div>

        {/* 纯净实体圆纽滑块 Thumb */}
        <div
          className={cn(
            'absolute top-[2px] bottom-[2px] pointer-events-none transition-all ease-out flex items-center',
            isDraggingRef.current ? 'duration-75 scale-105' : 'duration-200'
          )}
          style={{
            left: `calc(${ratio * 100}% - ${ratio * 26}px + 2px)`,
          }}
        >
          <div
            className={cn(
              'size-[22px] rounded-full bg-background shadow-xs border border-border/60 flex items-center justify-center transition-all',
              isMaxTier && 'border-primary ring-1 ring-primary/40 shadow-xs'
            )}
          />
        </div>
      </div>
    </div>
  )
}
