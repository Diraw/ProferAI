/**
 * 共享执行权（run ownership）最小机制。
 *
 * 目标：让**同一条 session 的执行权只有一份**，新旧两条执行链都能在「任何 await 之前」
 * 原子取得、按 owner token 释放，并且拒绝原因有稳定结构（不靠错误字符串判断）。
 *
 * 边界：
 * - 这里只做「谁持有 session 的执行权」这一件事；不承担消息持久化、事件投影、provider 启动，
 *   也不替代 `AgentRuntimeCoordinator` 的 stop/wait 路由。它不是一个第二套编排器。
 * - 单独实例化（不注入共享实例）时的默认行为 = 只在本协调器内互斥，与改造前等价；
 *   宿主把同一个实例注入两条执行链，才获得跨引擎互斥。
 * - token 只做身份校验：释放/标记只接受当前 owner 的 token，旧 run 的 finally 不能清掉新 run。
 */

import { AgentRunAlreadyActiveError, AgentSessionRuntimeMismatchError, type AgentRuntime } from '@profer/shared'

/**
 * owner token。新引擎用 `symbol`（同进程内不可能碰撞），旧引擎用既有 runGeneration 字符串；
 * 两者都只作为身份标识，registry 不解释其内容。
 */
export type AgentRunOwnershipToken = symbol | string

export interface AgentRunOwner {
  readonly sessionId: string
  readonly runtime: AgentRuntime
  readonly token: AgentRunOwnershipToken
  /** 取得执行权的时刻（毫秒）。只用于诊断，不参与判定。 */
  readonly claimedAt: number
}

/** 取得执行权失败的结构化原因；调用方据此映射具名错误，不做字符串比较。 */
export type AgentRunClaimFailure =
  | {
      readonly ok: false
      /** 同 session 已有 run 持有执行权（且请求的是同一内核）。 */
      readonly reason: 'already_active'
      readonly owner: AgentRunOwner
    }
  | {
      readonly ok: false
      /** 持有者或会话绑定的是另一个内核；请求不能执行，否则会污染跨内核 transcript。 */
      readonly reason: 'runtime_mismatch'
      readonly owner: AgentRunOwner
      readonly expected: AgentRuntime
      readonly received: AgentRuntime
    }

export type AgentRunClaimResult =
  | {
      readonly ok: true
      readonly owner: AgentRunOwner
      /** true = 同一 token 的嵌套取得（上层入口已持有，本次不重复占用）。 */
      readonly adopted: boolean
    }
  | AgentRunClaimFailure

export interface AgentRunClaimInput {
  readonly sessionId: string
  readonly runtime: AgentRuntime
  /**
   * 上层入口已经持有的 token。
   * 与当前 owner 的 token 相同 → 视为同一次请求的嵌套取得（`adopted: true`），不重复占用也不改 owner；
   * 不传 → 由 registry 生成新 token。
   */
  readonly token?: AgentRunOwnershipToken
}

export interface AgentRunOwnershipRegistryOptions {
  now?: () => number
}

/**
 * 单一 owner 登记表。
 *
 * 判定顺序与旧编排器一致（见 `agent-orchestrator.ts` 的 sendMessage 开头）：
 * 1. 已绑定另一内核 → `runtime_mismatch`；
 * 2. 同内核但已有 owner → `already_active`；
 * 3. 无 owner → 取得成功。
 */
export class AgentRunOwnershipRegistry {
  private readonly owners = new Map<string, AgentRunOwner>()
  private readonly now: () => number

  constructor(options: AgentRunOwnershipRegistryOptions = {}) {
    this.now = options.now ?? Date.now
  }

  /** 同步原子取得执行权；调用方必须在任何 await 之前调用。 */
  claim(input: AgentRunClaimInput): AgentRunClaimResult {
    const existing = this.owners.get(input.sessionId)
    if (existing) {
      if (input.token !== undefined && existing.token === input.token) {
        return { ok: true, owner: existing, adopted: true }
      }
      if (existing.runtime !== input.runtime) {
        return {
          ok: false,
          reason: 'runtime_mismatch',
          owner: existing,
          expected: existing.runtime,
          received: input.runtime,
        }
      }
      return { ok: false, reason: 'already_active', owner: existing }
    }

    const owner: AgentRunOwner = {
      sessionId: input.sessionId,
      runtime: input.runtime,
      token: input.token ?? Symbol(`agent-run:${input.sessionId}`),
      claimedAt: this.now(),
    }
    this.owners.set(input.sessionId, owner)
    return { ok: true, owner, adopted: false }
  }

  /** 只有当前 owner 的 token 能释放；返回 false 表示本次释放无效（旧 token / 已被接管）。 */
  release(sessionId: string, token: AgentRunOwnershipToken): boolean {
    const owner = this.owners.get(sessionId)
    if (!owner || owner.token !== token) return false
    this.owners.delete(sessionId)
    return true
  }

  getOwner(sessionId: string): AgentRunOwner | undefined {
    return this.owners.get(sessionId)
  }

  isOwned(sessionId: string): boolean {
    return this.owners.has(sessionId)
  }

  /** 当前持有执行权的会话 id；用于旧引擎保留 Map 风格调用点的只读视图。 */
  keys(): string[] {
    return [...this.owners.keys()]
  }

  /** 当前持有执行权的会话数；用于诊断与测试。 */
  ownerCount(): number {
    return this.owners.size
  }

  /** 宿主退出/测试清理用；不用于运行中的正常释放路径。 */
  releaseAll(): void {
    this.owners.clear()
  }
}

export function createAgentRunOwnershipRegistry(
  options: AgentRunOwnershipRegistryOptions = {},
): AgentRunOwnershipRegistry {
  return new AgentRunOwnershipRegistry(options)
}

/**
 * 把结构化拒绝原因映射为具名错误。
 *
 * - `already_active` → `AgentRunAlreadyActiveError`（`stopping` 由持有者状态决定，默认 false）
 * - `runtime_mismatch` → `AgentSessionRuntimeMismatchError`
 *
 * 调用方用 `instanceof` 识别，不要匹配 message。
 */
export function createAgentRunRejectionError(
  failure: AgentRunClaimFailure,
  options: { stopping?: boolean } = {},
): AgentRunAlreadyActiveError | AgentSessionRuntimeMismatchError {
  if (failure.reason === 'already_active') {
    return new AgentRunAlreadyActiveError(options.stopping === true)
  }
  return new AgentSessionRuntimeMismatchError(failure.expected, failure.received)
}

export function isAgentRunClaimFailure(result: AgentRunClaimResult): result is AgentRunClaimFailure {
  return result.ok === false
}

/**
 * 非破坏性预检：不取得执行权，只回答「如果现在 claim 会得到什么结果」。
 *
 * 供入口在**做任何副作用之前**同步失败（remote 的 `accepted` 应答、automation 的 `skipped` 记录）。
 * 它本身不是互斥手段（读后写仍可能竞争）；互斥仍由 `claim` 保证。因此调用方在预检与
 * `claim` 之间**不得有 await**（当前各入口两者之间均为同步语句，不存在窗口）。
 * 返回 `undefined` 表示当前无 owner，可以继续。
 */
export function peekAgentRunClaimFailure(
  registry: AgentRunOwnershipRegistry,
  sessionId: string,
  runtime: AgentRuntime,
): AgentRunClaimFailure | undefined {
  const owner = registry.getOwner(sessionId)
  if (!owner) return undefined
  if (owner.runtime !== runtime) {
    return { ok: false, reason: 'runtime_mismatch', owner, expected: owner.runtime, received: runtime }
  }
  return { ok: false, reason: 'already_active', owner }
}

/**
 * 旧引擎的只读视图：保留 `Map<string, string>` 风格的调用点（`get`/`has`/`keys`/`size`），
 * 唯一事实源仍是 registry。目的是让 `AgentOrchestrator` 里二十多处
 * `this.activeSessions.get(sessionId) === runGeneration` 类判断无需改写，
 * 同时不再存在第二张 owner 表（写入仍然只能通过 claim/release）。
 */
export interface AgentRunOwnershipView {
  get(sessionId: string): AgentRunOwnershipToken | undefined
  has(sessionId: string): boolean
  keys(): string[]
  readonly size: number
}

export function createAgentRunOwnershipView(registry: AgentRunOwnershipRegistry): AgentRunOwnershipView {
  return {
    get: sessionId => registry.getOwner(sessionId)?.token,
    has: sessionId => registry.isOwned(sessionId),
    keys: () => registry.keys(),
    get size() {
      return registry.ownerCount()
    },
  }
}
