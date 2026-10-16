/**
 * remote-agent-replay-registry — remote（Pocket）侧的**客户端绑定与回放登记**（GAP-3 / 原 B-6）
 *
 * 缺口来源（`integration/reports/04-gates-and-gaps.md` GAP-3）：
 * 桌面链有 `registerWebContents` + `activeStreamEventBacklogs` + `restoreActiveAgentStreams`，
 * 刷新后的渲染层能被重新绑定并回放「正在进行 / 刚结束的一轮」；remote 侧只有
 * `RemoteAgentEventLog` 的**游标补发**（客户端必须自己记住 cursor）。Pocket 刷新后内存
 * 状态丢失、拿不到 cursor，就只能拿到空回放 —— 正在飞的一轮无法重建。
 *
 * 本模块补的是**会话级登记**，不是桌面 webContents 机制的复制：
 * - 按 `sessionId` 保存本轮事件（不绑定任何 webContents / IPC 目标）；
 * - 客户端按自己的 key 声明关注哪些会话（多客户端、每客户端多会话，没有单客户端假设）；
 * - 回放按 eventId 升序、可去重，重复绑定 / 重复回放 / 迟到事件都不会产生重复消息或重复终态。
 *
 * 语义对齐桌面（不重复实现，只对齐口径）：
 * - 一轮的 backlog 在 run 结束（终态）后仍保留 `completedTtlMs`（默认 60s，与
 *   `COMPLETED_BACKLOG_TTL_MS` 一致），覆盖「刚结束就刷新」的竞态；
 * - `run_idle` 表示所有权释放：若此时还没见到终态，同样按「刚结束」保留一个 TTL 窗口，
 *   而不是立刻丢弃（否则刷新窗口内的客户端会什么都拿不到）；
 * - 新一轮开始（终态之后又出现非终态事件）会清掉上一轮的完成标记。
 *
 * 顺序假设：事件来自**同一进程的事件总线**，按到达顺序登记（单写者）。跨进程乱序不在本模块范围内。
 */

import type { AgentStreamPayload } from '@profer/shared'

export interface RemoteReplayRecord {
  eventId: number
  sessionId: string
  payload: AgentStreamPayload
  createdAt: number
}

export interface RemoteReplaySessionSnapshot {
  sessionId: string
  /** 尚未见到终态 ⇒ 一轮仍在进行。 */
  active: boolean
  hasTerminalEvent: boolean
  latestEventId: number | null
  eventCount: number
}

export interface RemoteReplayRequest {
  /**
   * 客户端已消费到的最大 eventId（只用于去重；不影响是否需要快照）。
   * `null` / 省略 = 无游标，仍可拿到完整的会话级 backlog。
   */
  sinceEventId?: number | null
  /** 只回放这些会话；未提供时按客户端绑定，客户端无绑定则回放全部活跃 / 刚落终态的会话。 */
  sessionIds?: readonly string[]
}

export interface RemoteReplayBatch {
  sessions: RemoteReplaySessionSnapshot[]
  records: RemoteReplayRecord[]
  /**
   * 登记已不完整（本轮早期事件被容量上限丢弃）⇒ 客户端必须改用快照重建。
   * 与桌面 `requiresSnapshot` 同义，但触发条件是**登记不完整**，不是游标过期。
   */
  requiresSnapshot: boolean
  oldestEventId: number | null
  latestEventId: number | null
}

export interface RemoteAgentReplayRegistryOptions {
  /** 终态会话保留窗口；覆盖「刚结束的一轮」的刷新竞态。默认 60s。 */
  completedTtlMs?: number
  /** 最多登记的会话数；超出时优先淘汰已结束且最旧的会话。 */
  maxSessions?: number
  /** 单会话最多保留的事件数；超出即标记 truncated（需要快照）。 */
  maxRecordsPerSession?: number
  now?: () => number
}

const DEFAULT_COMPLETED_TTL_MS = 60_000
const DEFAULT_MAX_SESSIONS = 64
const DEFAULT_MAX_RECORDS_PER_SESSION = 2000

interface SessionEntry {
  sessionId: string
  records: RemoteReplayRecord[]
  seenEventIds: Set<number>
  /** 已见到本轮终态（run_completed / run_complete / run_error）。 */
  hasTerminalEvent: boolean
  /** 完成（或 run_idle）时刻；undefined = 仍在进行。 */
  completedAt?: number
  /** 早期事件因容量上限被丢弃 ⇒ 登记不完整。 */
  truncated: boolean
}

/** 一轮的确定终态：与 `isTerminalBacklogEvent` 同口径，另含 remote 侧不下发的 run_complete / run_error。 */
function isTerminalPayload(payload: AgentStreamPayload): boolean {
  if (payload.kind === 'run_complete' || payload.kind === 'run_error') return true
  return payload.kind === 'profer_event' && payload.event.type === 'run_completed'
}

function isRunIdlePayload(payload: AgentStreamPayload): boolean {
  return payload.kind === 'profer_event' && payload.event.type === 'run_idle'
}

/** 会话无关的全局投影事件：不属于任何一轮的事件流（与桌面 backlog 中间件同一排除口径）。 */
function isSessionAgnosticPayload(payload: AgentStreamPayload): boolean {
  return payload.kind === 'session_projection' || payload.kind === 'catalog_invalidation'
}

export class RemoteAgentReplayRegistry {
  private readonly entries = new Map<string, SessionEntry>()
  private readonly bindings = new Map<string, Set<string>>()
  private readonly completedTtlMs: number
  private readonly maxSessions: number
  private readonly maxRecordsPerSession: number
  private readonly now: () => number

  constructor(options: RemoteAgentReplayRegistryOptions = {}) {
    this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.maxRecordsPerSession = options.maxRecordsPerSession ?? DEFAULT_MAX_RECORDS_PER_SESSION
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 登记一条已发生的事件。
   *
   * 返回 `false` 表示未登记（全局投影事件 / 重复 eventId / 同一轮的重复终态）。
   * 重复终态被丢弃，是「迟到事件不得产生重复终态」的关键保护。
   */
  observe(record: RemoteReplayRecord): boolean {
    if (isSessionAgnosticPayload(record.payload)) return false
    const now = this.now()
    this.prune(now)

    const entry = this.entries.get(record.sessionId) ?? {
      sessionId: record.sessionId,
      records: [],
      seenEventIds: new Set<number>(),
      hasTerminalEvent: false,
      truncated: false,
    }

    if (entry.seenEventIds.has(record.eventId)) return false
    entry.seenEventIds.add(record.eventId)

    if (isRunIdlePayload(record.payload)) {
      // 所有权释放：还没见到终态时按「刚结束」保留一个 TTL 窗口，而不是立刻丢弃。
      if (entry.completedAt === undefined) entry.completedAt = now
    } else if (isTerminalPayload(record.payload)) {
      if (entry.hasTerminalEvent) return false
      entry.hasTerminalEvent = true
      entry.completedAt = now
    } else {
      // 终态之后又出现非终态事件 ⇒ 新一轮开始，清掉上一轮的完成标记。
      entry.completedAt = undefined
      entry.hasTerminalEvent = false
    }

    entry.records.push(record)
    if (entry.records.length > this.maxRecordsPerSession) {
      entry.records.splice(0, entry.records.length - this.maxRecordsPerSession)
      entry.truncated = true
    }
    this.entries.set(record.sessionId, entry)
    this.enforceSessionCap()
    return true
  }

  /** 客户端声明关注某个会话。幂等：重复绑定不产生任何副作用。 */
  bindClient(clientKey: string, sessionId: string): void {
    const bound = this.bindings.get(clientKey) ?? new Set<string>()
    bound.add(sessionId)
    this.bindings.set(clientKey, bound)
  }

  /** 取消绑定（不传 sessionId 时清空该客户端的全部绑定）。 */
  unbindClient(clientKey: string, sessionId?: string): void {
    if (sessionId === undefined) {
      this.bindings.delete(clientKey)
      return
    }
    const bound = this.bindings.get(clientKey)
    if (!bound) return
    bound.delete(sessionId)
    if (bound.size === 0) this.bindings.delete(clientKey)
  }

  /** 该客户端是否已声明过关注会话。 */
  hasClient(clientKey: string): boolean {
    return (this.bindings.get(clientKey)?.size ?? 0) > 0
  }

  /**
   * 该客户端应看到的会话快照。
   *
   * - 已绑定会话的客户端：只返回绑定过的会话（多客户端互不干扰）；
   * - 未绑定的客户端（如刚刷新的 Pocket）：按桌面「刷新恢复」语义返回全部活跃 / 刚落终态的会话。
   */
  sessionsFor(clientKey: string, sessionIds?: readonly string[]): RemoteReplaySessionSnapshot[] {
    this.prune()
    const bound = this.bindings.get(clientKey)
    const explicit = sessionIds && sessionIds.length > 0 ? new Set(sessionIds) : undefined
    return [...this.entries.values()]
      .filter((entry) => {
        if (explicit) return explicit.has(entry.sessionId)
        if (bound && bound.size > 0) return bound.has(entry.sessionId)
        return true
      })
      .sort((a, b) => (a.records[0]?.eventId ?? 0) - (b.records[0]?.eventId ?? 0))
      .map((entry) => this.toSnapshot(entry))
  }

  /** 生成给该客户端的回放批次（按 eventId 升序，去重）。 */
  replayFor(clientKey: string, request: RemoteReplayRequest = {}): RemoteReplayBatch {
    this.prune()
    const sessions = this.sessionsFor(clientKey, request.sessionIds)
    const sessionIds = new Set(sessions.map((session) => session.sessionId))
    const entries = [...this.entries.values()].filter((entry) => sessionIds.has(entry.sessionId))

    const since = typeof request.sinceEventId === 'number' ? request.sinceEventId : null
    const records = entries
      .flatMap((entry) => entry.records)
      .filter((record) => since === null || record.eventId > since)
      .sort((a, b) => a.eventId - b.eventId)

    const requiresSnapshot = entries.some((entry) => entry.truncated)
    const allRecords = entries.flatMap((entry) => entry.records)

    return {
      sessions,
      records: requiresSnapshot ? [] : records,
      requiresSnapshot,
      oldestEventId: allRecords.length > 0 ? Math.min(...allRecords.map((record) => record.eventId)) : null,
      latestEventId: allRecords.length > 0 ? Math.max(...allRecords.map((record) => record.eventId)) : null,
    }
  }

  /** 显式丢弃某个会话的登记（会话删除 / run 彻底结束且无需回放时使用）。 */
  clearSession(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** 过期清理：已结束会话超过 TTL 即释放。 */
  prune(now: number = this.now()): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.completedAt !== undefined && now - entry.completedAt > this.completedTtlMs) {
        this.entries.delete(sessionId)
      }
    }
  }

  /** 当前登记的会话数（诊断 / 测试用）。 */
  get size(): number {
    return this.entries.size
  }

  private toSnapshot(entry: SessionEntry): RemoteReplaySessionSnapshot {
    return {
      sessionId: entry.sessionId,
      active: entry.completedAt === undefined,
      hasTerminalEvent: entry.hasTerminalEvent,
      latestEventId: entry.records.length > 0
        ? Math.max(...entry.records.map((record) => record.eventId))
        : null,
      eventCount: entry.records.length,
    }
  }

  private enforceSessionCap(): void {
    if (this.entries.size <= this.maxSessions) return
    const ordered = [...this.entries.values()].sort((a, b) => {
      // 优先淘汰已结束且最旧的会话；仍在进行的会话排到最后。
      const aDone = a.completedAt ?? Number.POSITIVE_INFINITY
      const bDone = b.completedAt ?? Number.POSITIVE_INFINITY
      if (aDone !== bDone) return aDone - bDone
      return (a.records[0]?.eventId ?? 0) - (b.records[0]?.eventId ?? 0)
    })
    const excess = this.entries.size - this.maxSessions
    for (let index = 0; index < excess; index += 1) {
      const victim = ordered[index]
      if (victim) this.entries.delete(victim.sessionId)
    }
  }
}
