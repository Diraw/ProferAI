/**
 * Agent Fabric 协议基础层
 *
 * 定义协议版本、统一请求 envelope、错误码与幂等语义。
 * 所有传输适配器（local-http / MCP / 未来远程 server）都必须转换到本层模型，
 * 不允许传输层自带一套任务状态或持久化语义。
 */

/** 当前协议版本。主版本不兼容变更时必须提升。 */
export const PROTOCOL_VERSION = '1.0' as const

/** 本实现可接受的协议版本集合（用于向前/向后兼容窗口）。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION]

/** 协议调用方身份：只标识“谁在调用”，不携带任何凭据。 */
export interface ProtocolActor {
  agentId: string
  instanceId?: string
}

/**
 * 统一请求 envelope。
 * - requestId 解决调用重试幂等：同一 requestId 重复提交必须返回首次结果；
 * - 业务任务身份用 taskId（在 payload 内），两者职责不同。
 */
export interface ProtocolEnvelope<TPayload> {
  protocolVersion: string
  requestId: string
  actor: ProtocolActor
  payload: TPayload
}

/** 统一响应 envelope。ok=false 时 error 必填。 */
export interface ProtocolResponse<TPayload> {
  protocolVersion: string
  requestId: string
  ok: boolean
  payload?: TPayload
  error?: ProtocolErrorShape
}

/**
 * 协议错误码。
 * 命名即语义，调用方据此决定重试/拒绝/上报，不解析自然语言 message。
 */
export const ProtocolErrorCode = {
  // 协议与校验
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  DUPLICATE_REQUEST_IN_FLIGHT: 'DUPLICATE_REQUEST_IN_FLIGHT',
  // 节点与路由
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_OFFLINE: 'AGENT_OFFLINE',
  AGENT_BUSY: 'AGENT_BUSY',
  ENDPOINT_NOT_REGISTERED: 'ENDPOINT_NOT_REGISTERED',
  // 权限与策略
  CALLER_NOT_PAIRED: 'CALLER_NOT_PAIRED',
  PAIRING_REVOKED: 'PAIRING_REVOKED',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  POLICY_WIDENING_REJECTED: 'POLICY_WIDENING_REJECTED',
  DELEGATION_DEPTH_EXCEEDED: 'DELEGATION_DEPTH_EXCEEDED',
  MAX_CHILDREN_EXCEEDED: 'MAX_CHILDREN_EXCEEDED',
  SENSITIVE_INLINE_CONTENT: 'SENSITIVE_INLINE_CONTENT',
  WORKSPACE_CONFLICT: 'WORKSPACE_CONFLICT',
  // 任务生命周期
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_TERMINAL: 'TASK_TERMINAL',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  TASK_LEASE_EXPIRED: 'TASK_LEASE_EXPIRED',
  // 审批
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_REPLAY: 'APPROVAL_REPLAY',
  APPROVAL_BINDING_MISMATCH: 'APPROVAL_BINDING_MISMATCH',
  // 产物
  ARTIFACT_NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  ARTIFACT_EXPIRED: 'ARTIFACT_EXPIRED',
  // 任务图
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  DEPENDENCY_NOT_FOUND: 'DEPENDENCY_NOT_FOUND',
} as const

export type ProtocolErrorCodeValue = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode]

export interface ProtocolErrorShape {
  code: ProtocolErrorCodeValue
  message: string
  /** retryable=true 表示调用方可以用新 requestId 安全重试。 */
  retryable: boolean
  details?: Record<string, unknown>
}

/** 协议层统一异常。message 用中文，供日志与 UI 直接展示。 */
export class ProtocolError extends Error implements ProtocolErrorShape {
  readonly code: ProtocolErrorCodeValue
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(code: ProtocolErrorCodeValue, message: string, opts?: { retryable?: boolean; details?: Record<string, unknown> }) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.retryable = opts?.retryable ?? false
    this.details = opts?.details
  }

  toShape(): ProtocolErrorShape {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details }
  }
}

/** 构造请求 envelope。requestId 必须由调用方生成并在重试时保持不变。 */
export function createEnvelope<TPayload>(actor: ProtocolActor, requestId: string, payload: TPayload): ProtocolEnvelope<TPayload> {
  return { protocolVersion: PROTOCOL_VERSION, requestId, actor, payload }
}

/** 校验 envelope 的版本与必填字段；不合法直接抛 ProtocolError。 */
export function validateEnvelope<TPayload>(envelope: ProtocolEnvelope<TPayload>): void {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(envelope.protocolVersion)) {
    throw new ProtocolError(
      ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
      `不支持的协议版本：${envelope.protocolVersion}（当前支持 ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}）`,
      { retryable: false },
    )
  }
  if (!envelope.requestId || envelope.requestId.trim() === '') {
    throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, 'requestId 不能为空（幂等依赖该字段）')
  }
  if (!envelope.actor?.agentId) {
    throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, 'actor.agentId 不能为空')
  }
}

/** 幂等记录：requestId -> 首次处理结果。 */
export interface IdempotencyRecord<TResult> {
  requestId: string
  status: 'in_flight' | 'completed'
  result?: TResult
  createdAt: number
}

/**
 * 幂等账本。
 * 语义：
 * - begin()：同一 requestId 已完成 → 返回缓存结果（重复提交不重复执行）；
 *            同一 requestId 正在执行 → 抛 DUPLICATE_REQUEST_IN_FLIGHT；
 * - complete()：写入首次处理结果，之后同 requestId 的调用都命中缓存。
 */
export class IdempotencyLedger<TResult> {
  private readonly records = new Map<string, IdempotencyRecord<TResult>>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  /** 返回 undefined 表示首次执行，调用方应继续处理。 */
  begin(requestId: string): IdempotencyRecord<TResult> | undefined {
    const existing = this.records.get(requestId)
    if (existing) {
      if (existing.status === 'in_flight') {
        throw new ProtocolError(
          ProtocolErrorCode.DUPLICATE_REQUEST_IN_FLIGHT,
          `请求 ${requestId} 正在执行中，请勿并发重试`,
          { retryable: true },
        )
      }
      return existing
    }
    this.records.set(requestId, { requestId, status: 'in_flight', createdAt: this.now() })
    return undefined
  }

  complete(requestId: string, result: TResult): void {
    const existing = this.records.get(requestId)
    if (!existing) {
      throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, `幂等账本中不存在请求 ${requestId}，无法写入结果`)
    }
    existing.status = 'completed'
    existing.result = result
  }

  /** 执行失败时释放 in_flight，让调用方可以用同一 requestId 重试。 */
  release(requestId: string): void {
    const existing = this.records.get(requestId)
    if (existing?.status === 'in_flight') {
      this.records.delete(requestId)
    }
  }
}
