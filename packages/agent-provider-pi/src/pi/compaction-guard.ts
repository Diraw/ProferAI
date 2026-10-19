/**
 * 手动压缩前置守卫。
 *
 * Pi SDK 的 `prepareCompaction` 只有两条跳过条件：路径为空、最后一条已经是压缩。
 * Claude Code 的反应式压缩有 11 条跳过原因，其中「只有 1 轮不值得压」「上次压缩还悬着」
 * 「连续压缩熔断」这三条在 Pi 路径上完全缺失，会变成无效压缩：
 * 小会话压一次白烧一次摘要调用，压缩还没回来又压一次，压缩完立刻又满再压。
 *
 * 边界（不要越界）：
 * - 自动压缩由 Pi SDK 内部的 `shouldCompact` 在 agent loop 里触发，宿主只能控制
 *   `enabled` / `reserveTokens`，插不进跳过逻辑，所以本守卫只覆盖 Profer 自己发起的
 *   `session.compact()`（`/compact` 与模型调用的 CompactContext）。
 * - 不改 SDK 内部实现，所有补偿留在 Profer 侧。
 */

/** 手动压缩被跳过时的原因；与 Claude Code 的 skipReason 一一对应。 */
export type PiManualCompactionSkipReason = 'too_few_turns' | 'in_flight' | 'circuit_open'

/** 跳过提示的系统消息 subtyp；渲染层按它渲染一条可见提示。 */
export const PI_COMPACTION_SKIPPED_SUBTYPE = 'compact_skipped'

export interface PiManualCompactionGuardOptions {
  /** 有效轮次下限，低于它压缩没有收益（Claude Code 的 one_round）。 */
  minTurns?: number
  /** 熔断窗口：窗口内成功压缩达到上限后，拒绝新的手动压缩。 */
  circuitWindowMs?: number
  /** 窗口内允许的成功压缩次数，达到后熔断。 */
  circuitMaxCompactions?: number
  /** 会话状态条目上限，防止长期运行的进程里 Map 无限增长。 */
  maxTrackedSessions?: number
  now?: () => number
}

export interface PiManualCompactionDecision {
  allowed: boolean
  reason?: PiManualCompactionSkipReason
  message?: string
}

interface SessionCompactionState {
  inFlight: boolean
  /** 窗口内成功压缩的时间戳，升序。 */
  completedAt: number[]
  lastTouched: number
}

const DEFAULT_OPTIONS = {
  minTurns: 2,
  circuitWindowMs: 5 * 60_000,
  circuitMaxCompactions: 2,
  maxTrackedSessions: 200,
} as const

const REASON_TEXT: Record<PiManualCompactionSkipReason, (options: { turnCount: number; windowMinutes: number; limit: number }) => string> = {
  too_few_turns: ({ turnCount }) =>
    `当前会话只有 ${turnCount} 轮有效对话，压缩没有收益，已跳过。继续对话后再压缩。`,
  in_flight: () => '上一次压缩还没结束，已跳过本次请求。',
  circuit_open: ({ windowMinutes, limit }) =>
    `最近 ${windowMinutes} 分钟内已连续压缩 ${limit} 次，暂时跳过本次压缩以免反复压缩。继续对话，稍后再试。`,
}

/** 取出 user 消息里的可见文本；非文本块（图片等）留空。 */
function userMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Array<{ type?: unknown; text?: unknown } | null>) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function hasImageBlock(message: unknown): boolean {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return false
  return (content as Array<{ type?: unknown } | null>).some((block) => block?.type === 'image')
}

/**
 * 统计「有效轮次」：至少含一段非空文本或一张图片的 user 消息。
 *
 * `ignoreTextPrefixes` 用来排除 Profer 自己注入的消息（例如压缩后的续跑指令），
 * 它们不是用户真实输入，不该让「只有 1 轮」的判断失效。
 */
export function countPiEffectiveTurns(
  messages: ReadonlyArray<unknown>,
  options: { ignoreTextPrefixes?: readonly string[] } = {},
): number {
  const ignore = options.ignoreTextPrefixes ?? []
  let turns = 0
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if ((message as { role?: unknown }).role !== 'user') continue
    const text = userMessageText(message).trimStart()
    if (ignore.some((prefix) => prefix.length > 0 && text.startsWith(prefix))) continue
    if (text.trim().length === 0 && !hasImageBlock(message)) continue
    turns += 1
  }
  return turns
}

/**
 * 会话级的手动压缩守卫。
 *
 * 状态按 sessionId 保存在 adapter 实例上（不是 query 调用内）：每次 `/compact` 都是新的
 * query，跨调用的 in-flight 标记和熔断计数只能放在更外层。
 */
export class PiManualCompactionGuard {
  private readonly options: Required<Omit<PiManualCompactionGuardOptions, 'now'>> & { now: () => number }
  private readonly sessions = new Map<string, SessionCompactionState>()

  constructor(options: PiManualCompactionGuardOptions = {}) {
    this.options = {
      minTurns: options.minTurns ?? DEFAULT_OPTIONS.minTurns,
      circuitWindowMs: options.circuitWindowMs ?? DEFAULT_OPTIONS.circuitWindowMs,
      circuitMaxCompactions: options.circuitMaxCompactions ?? DEFAULT_OPTIONS.circuitMaxCompactions,
      maxTrackedSessions: options.maxTrackedSessions ?? DEFAULT_OPTIONS.maxTrackedSessions,
      now: options.now ?? (() => Date.now()),
    }
  }

  evaluate(sessionId: string, turnCount: number): PiManualCompactionDecision {
    const now = this.options.now()
    const state = this.sessions.get(sessionId)
    if (state) {
      state.lastTouched = now
      state.completedAt = state.completedAt.filter((at) => now - at < this.options.circuitWindowMs)
    }

    if (state?.inFlight) return this.skip('in_flight', turnCount)
    if (turnCount < this.options.minTurns) return this.skip('too_few_turns', turnCount)
    if (state && state.completedAt.length >= this.options.circuitMaxCompactions) return this.skip('circuit_open', turnCount)

    this.prune()
    return { allowed: true }
  }

  /** 标记压缩开始；`evaluate` 通过后、调用 `session.compact()` 之前调用。 */
  begin(sessionId: string): void {
    const state = this.stateOf(sessionId)
    state.inFlight = true
    state.lastTouched = this.options.now()
  }

  /**
   * 标记压缩结束。
   *
   * 只有真正产出摘要的 `compacted` 计入熔断：`noop`（会话太小/已压缩过）和
   * `failed` 都说明压缩没有反复发生，计入会让后续正常压缩被误挡。
   */
  settle(sessionId: string, outcome: 'compacted' | 'failed' | 'noop'): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    const now = this.options.now()
    state.inFlight = false
    state.lastTouched = now
    if (outcome === 'compacted') state.completedAt.push(now)
  }

  /** 会话状态快照，供诊断与单测使用。 */
  inspect(sessionId: string): { inFlight: boolean; recentCompactions: number } | undefined {
    const state = this.sessions.get(sessionId)
    if (!state) return undefined
    const now = this.options.now()
    return {
      inFlight: state.inFlight,
      recentCompactions: state.completedAt.filter((at) => now - at < this.options.circuitWindowMs).length,
    }
  }

  private skip(reason: PiManualCompactionSkipReason, turnCount: number): PiManualCompactionDecision {
    return {
      allowed: false,
      reason,
      message: REASON_TEXT[reason]({
        turnCount,
        windowMinutes: Math.round(this.options.circuitWindowMs / 60_000),
        limit: this.options.circuitMaxCompactions,
      }),
    }
  }

  private stateOf(sessionId: string): SessionCompactionState {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const created: SessionCompactionState = { inFlight: false, completedAt: [], lastTouched: this.options.now() }
    this.sessions.set(sessionId, created)
    return created
  }

  /** 丢掉过期会话；超过条目上限时按最久未触碰优先淘汰。 */
  private prune(): void {
    const now = this.options.now()
    const staleBefore = now - Math.max(this.options.circuitWindowMs * 12, 60 * 60_000)
    for (const [sessionId, state] of this.sessions) {
      if (!state.inFlight && state.lastTouched < staleBefore) this.sessions.delete(sessionId)
    }
    if (this.sessions.size <= this.options.maxTrackedSessions) return
    const ordered = [...this.sessions.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched)
    for (const [sessionId] of ordered.slice(0, this.sessions.size - this.options.maxTrackedSessions)) {
      this.sessions.delete(sessionId)
    }
  }
}

/** 跳过提示的系统消息；渲染层按 `compact_skipped` 渲染成一条提示。 */
export function createPiCompactionSkippedMessage(
  sessionId: string,
  reason: PiManualCompactionSkipReason,
  message: string,
): { type: 'system'; subtype: string; session_id: string; reason: string; message: string } {
  return {
    type: 'system',
    subtype: PI_COMPACTION_SKIPPED_SUBTYPE,
    session_id: sessionId,
    reason,
    message,
  }
}
