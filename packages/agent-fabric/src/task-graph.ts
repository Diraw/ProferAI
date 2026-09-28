/**
 * Task Graph 与委派策略
 *
 * 核心不变量：子任务策略只能继承或收窄，永远不能扩大父任务授权。
 * 审批策略同理——子 Agent 不能通过再次委派绕过父任务的审批要求。
 */

import { ProtocolError, ProtocolErrorCode } from './protocol'
import {
  WORKSPACE_MODE_RESTRICTIVENESS,
  type AgentTask,
  type TaskPolicy,
} from './task'

/** 子任务与父任务的连接信息（任务树 + DAG 依赖分开记录）。 */
export interface ChildTaskLink {
  parentTaskId: string
  rootTaskId: string
  /** DAG 依赖：可等待多个前置任务，但不得跨出当前任务图。 */
  dependsOn: readonly string[]
  requesterAgentId: string
  orchestratorAgentId: string
  targetAgentId: string
  aggregationMode: 'wait-all' | 'wait-any' | 'fire-and-forget'
}

/**
 * 策略收窄校验：逐项检查 child 相对 parent 是否更严格或持平。
 * 返回违规项列表；为空表示收窄合法。
 */
export function findPolicyWidening(parent: TaskPolicy, child: TaskPolicy): string[] {
  const violations: string[] = []

  if (child.maxDelegationDepth > parent.maxDelegationDepth) {
    violations.push(`maxDelegationDepth ${parent.maxDelegationDepth} -> ${child.maxDelegationDepth}`)
  }
  if (child.maxChildren > parent.maxChildren) {
    violations.push(`maxChildren ${parent.maxChildren} -> ${child.maxChildren}`)
  }
  if (child.timeoutSeconds > parent.timeoutSeconds) {
    violations.push(`timeoutSeconds ${parent.timeoutSeconds} -> ${child.timeoutSeconds}`)
  }
  if (
    WORKSPACE_MODE_RESTRICTIVENESS[child.workspaceMode] >
    WORKSPACE_MODE_RESTRICTIVENESS[parent.workspaceMode]
  ) {
    violations.push(`workspaceMode ${parent.workspaceMode} -> ${child.workspaceMode}（变得更强写）`)
  }
  if (parent.allowedCapabilities) {
    const parentCaps = new Set(parent.allowedCapabilities)
    for (const cap of child.allowedCapabilities ?? []) {
      if (!parentCaps.has(cap)) violations.push(`allowedCapabilities 新增 ${cap}`)
    }
    // 父级有白名单而子级没有声明，视为继承父白名单（不违规），由 narrowPolicy 收敛。
  }
  if (parent.budget && child.budget) {
    if (child.budget.unit === parent.budget.unit && child.budget.maxUnits > parent.budget.maxUnits) {
      violations.push(`budget ${parent.budget.maxUnits} -> ${child.budget.maxUnits} ${parent.budget.unit}`)
    }
  }
  // 审批模式只允许保持或更严格：forward_to_user 不能被子任务降级。
  if (parent.approvalMode === 'forward_to_user' && child.approvalMode !== 'forward_to_user') {
    violations.push(`approvalMode ${parent.approvalMode} -> ${child.approvalMode}（审批被绕过）`)
  }
  return violations
}

/**
 * 生成子任务策略：以 child 声明为准做逐项收窄，未声明的继承父级；
 * 任何扩大都抛 POLICY_WIDENING_REJECTED。
 */
export function narrowPolicy(parent: TaskPolicy, child: Partial<TaskPolicy>): TaskPolicy {
  const merged: TaskPolicy = {
    approvalMode: child.approvalMode ?? parent.approvalMode,
    allowDelegation: child.allowDelegation ?? parent.allowDelegation,
    maxDelegationDepth: child.maxDelegationDepth ?? parent.maxDelegationDepth,
    maxChildren: child.maxChildren ?? parent.maxChildren,
    timeoutSeconds: child.timeoutSeconds ?? parent.timeoutSeconds,
    workspaceMode: child.workspaceMode ?? parent.workspaceMode,
    writeIntent: child.writeIntent ?? parent.writeIntent,
    allowedCapabilities: child.allowedCapabilities ?? parent.allowedCapabilities,
    retryClass: child.retryClass ?? parent.retryClass,
    budget: child.budget ?? parent.budget,
  }

  const violations = findPolicyWidening(parent, merged)
  if (violations.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.POLICY_WIDENING_REJECTED,
      `子任务策略试图扩大父任务授权：${violations.join('；')}`,
      { details: { violations } },
    )
  }
  return merged
}

// ===== 委派边界 =====

export interface DelegationGuardInput {
  parent: AgentTask
  /** 父任务当前已派生的直接子任务数。 */
  currentChildCount: number
  /** 父任务的委派深度（root = 0）。 */
  parentDepth: number
}

/** 派生子任务前的边界检查：深度、子任务数、父任务自身策略。 */
export function assertDelegationAllowed(input: DelegationGuardInput): void {
  const { policy } = input.parent.request
  if (!policy.allowDelegation) {
    throw new ProtocolError(ProtocolErrorCode.POLICY_VIOLATION, '父任务 policy.allowDelegation=false，禁止派生子任务')
  }
  if (input.parentDepth + 1 > policy.maxDelegationDepth) {
    throw new ProtocolError(
      ProtocolErrorCode.DELEGATION_DEPTH_EXCEEDED,
      `委派深度超限：当前 ${input.parentDepth}，上限 ${policy.maxDelegationDepth}`,
      { details: { parentDepth: input.parentDepth, maxDelegationDepth: policy.maxDelegationDepth } },
    )
  }
  if (input.currentChildCount >= policy.maxChildren) {
    throw new ProtocolError(
      ProtocolErrorCode.MAX_CHILDREN_EXCEEDED,
      `子任务数超限：已有 ${input.currentChildCount}，上限 ${policy.maxChildren}`,
      { details: { currentChildCount: input.currentChildCount, maxChildren: policy.maxChildren } },
    )
  }
}

// ===== DAG 依赖 =====

/** 依赖环检测（DFS）。存在环时抛 DEPENDENCY_CYCLE。 */
export function assertNoDependencyCycle(edges: ReadonlyMap<string, readonly string[]>): void {
  const visiting = new Set<string>()
  const done = new Set<string>()

  const visit = (node: string, path: string[]): void => {
    if (done.has(node)) return
    if (visiting.has(node)) {
      throw new ProtocolError(
        ProtocolErrorCode.DEPENDENCY_CYCLE,
        `任务依赖存在环：${[...path, node].join(' -> ')}`,
        { details: { cycle: [...path, node] } },
      )
    }
    visiting.add(node)
    for (const dep of edges.get(node) ?? []) {
      visit(dep, [...path, node])
    }
    visiting.delete(node)
    done.add(node)
  }

  for (const node of edges.keys()) {
    visit(node, [])
  }
}

/**
 * 校验子任务的 dependsOn 全部属于当前任务图（同一 rootTaskId）。
 * 防止子任务挂到别的图的资源或审批上下文上。
 */
export function assertDependsOnWithinGraph(link: ChildTaskLink, knownTaskIdsByRoot: ReadonlyMap<string, ReadonlySet<string>>): void {
  const graphTaskIds = knownTaskIdsByRoot.get(link.rootTaskId)
  for (const dep of link.dependsOn) {
    if (!graphTaskIds?.has(dep)) {
      throw new ProtocolError(
        ProtocolErrorCode.DEPENDENCY_NOT_FOUND,
        `依赖任务 ${dep} 不属于任务图 ${link.rootTaskId}（禁止跨图依赖）`,
        { details: { missing: dep, rootTaskId: link.rootTaskId } },
      )
    }
  }
}
