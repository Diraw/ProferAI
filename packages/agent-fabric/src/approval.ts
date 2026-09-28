/**
 * 审批绑定契约
 *
 * 高风险操作审批归原始用户，而不是自动归父 Agent。
 * 审批 token 一次性使用，不可跨任务、跨 Agent、跨 workspace、跨版本重放。
 */

import type { CapabilityValue } from './capabilities'
import { ProtocolError, ProtocolErrorCode } from './protocol'

/** 审批请求：绑定任务图位置、操作摘要与有效期。 */
export interface ApprovalRequest {
  approvalId: string
  taskId: string
  rootTaskId: string
  /** 原始调用方（如 hermes），审计链路的起点。 */
  requesterAgentId: string
  /** 实际执行操作的节点（如 profer-dev）。 */
  targetAgentId: string
  workspaceScope: string
  capability: CapabilityValue
  /** 面向用户的具体操作摘要（如“删除 dist/ 并重新打包”）。 */
  operationSummary: string
  expiresAt: number
  createdAt: number
  /** 协议版本：版本变化后旧审批一律失效，防跨版本重放。 */
  protocolVersion: string
}

export type ApprovalDecisionKind = 'approved' | 'denied'

/** 一次性审批决定。token 与 approvalId 绑定，消费后即失效。 */
export interface ApprovalDecision {
  approvalId: string
  decision: ApprovalDecisionKind
  /** 审批只能由用户做出；任何 Agent 都不能成为 decidedBy。 */
  decidedBy: 'user'
  decidedAt: number
  oneTimeToken: string
}

/**
 * 消费上下文：执行节点兑现审批时必须逐项匹配。
 * 任何一项不符都是绑定失配（拒绝），不是“近似可信”。
 */
export interface ApprovalConsumeContext {
  taskId: string
  rootTaskId: string
  targetAgentId: string
  workspaceScope: string
  capability: CapabilityValue
  protocolVersion: string
}

/** 消费前置校验：绑定匹配 + 未过期。返回原请求供后续 token 消费。 */
export function assertApprovalConsumable(
  request: ApprovalRequest,
  context: ApprovalConsumeContext,
  now: number = Date.now(),
): void {
  if (request.expiresAt <= now) {
    throw new ProtocolError(
      ProtocolErrorCode.APPROVAL_EXPIRED,
      `审批 ${request.approvalId} 已过期，必须重新向用户请求`,
      { retryable: false },
    )
  }
  const mismatches: string[] = []
  if (request.taskId !== context.taskId) mismatches.push(`taskId ${request.taskId} != ${context.taskId}`)
  if (request.rootTaskId !== context.rootTaskId) mismatches.push(`rootTaskId ${request.rootTaskId} != ${context.rootTaskId}`)
  if (request.targetAgentId !== context.targetAgentId) mismatches.push(`targetAgentId ${request.targetAgentId} != ${context.targetAgentId}`)
  if (request.workspaceScope !== context.workspaceScope) mismatches.push(`workspaceScope ${request.workspaceScope} != ${context.workspaceScope}`)
  if (request.capability !== context.capability) mismatches.push(`capability ${request.capability} != ${context.capability}`)
  if (request.protocolVersion !== context.protocolVersion) mismatches.push(`protocolVersion ${request.protocolVersion} != ${context.protocolVersion}`)
  if (mismatches.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.APPROVAL_BINDING_MISMATCH,
      `审批 ${request.approvalId} 不允许跨任务/跨 Agent/跨 scope 使用：${mismatches.join('；')}`,
      { details: { mismatches } },
    )
  }
}

/**
 * 一次性 token 账本。
 * consume 返回 true 表示首次兑现；重复兑现返回 false（调用方应抛 APPROVAL_REPLAY）。
 */
export class ApprovalTokenLedger {
  private readonly consumed = new Set<string>()

  consume(decision: ApprovalDecision, request: ApprovalRequest): void {
    if (decision.approvalId !== request.approvalId || decision.oneTimeToken === '') {
      throw new ProtocolError(
        ProtocolErrorCode.APPROVAL_BINDING_MISMATCH,
        `审批决定与请求不绑定：decision.approvalId=${decision.approvalId}，request.approvalId=${request.approvalId}`,
      )
    }
    const key = `${decision.approvalId}:${decision.oneTimeToken}`
    if (this.consumed.has(key)) {
      throw new ProtocolError(
        ProtocolErrorCode.APPROVAL_REPLAY,
        `审批 ${decision.approvalId} 的 token 已被消费，拒绝重放`,
      )
    }
    this.consumed.add(key)
  }
}
