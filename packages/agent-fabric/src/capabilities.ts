/**
 * 能力目录与授权解析
 *
 * 能力是独立授予的最小权限单元，不存在“全能 token”。
 * 有效能力 = 调用方 grant ∩ 目标节点能力 ∩ 任务 policy ∩ 当前信任前提，
 * 任何一层拒绝即拒绝（fail-closed）。
 */

import { ProtocolError, ProtocolErrorCode } from './protocol'

/** 全部可声明能力。新增能力必须同步更新 CAPABILITY_READINESS。 */
export const Capability = {
  // 任务面
  AGENT_EXECUTE: 'agent.execute',
  TASK_SUBMIT: 'task.submit',
  TASK_READ: 'task.read',
  TASK_CANCEL: 'task.cancel',
  TASK_DELEGATE: 'task.delegate',
  TASK_APPROVE: 'task.approve',
  // 工作区与执行
  WORKSPACE_READ: 'workspace.read',
  WORKSPACE_WRITE: 'workspace.write',
  SHELL_RUN: 'shell.run',
  TEST_RUN: 'test.run',
  // 运行时诊断（Stable 调 Dev 的公开诊断面）
  RUNTIME_INSPECT: 'runtime.inspect',
  RUNTIME_HEALTH: 'runtime.health',
  RUNTIME_LOGS: 'runtime.logs',
  RUNTIME_RUN_SMOKE_TEST: 'runtime.run_smoke_test',
  RUNTIME_COLLECT_ARTIFACTS: 'runtime.collect_artifacts',
  RUNTIME_RESTART: 'runtime.restart',
  // 产物与外发
  ARTIFACT_READ: 'artifact.read',
  ARTIFACT_CREATE: 'artifact.create',
  EXTERNAL_PUBLISH: 'external.publish',
} as const

export type CapabilityValue = (typeof Capability)[keyof typeof Capability]

export const ALL_CAPABILITIES: readonly CapabilityValue[] = Object.values(Capability)

/**
 * 能力就绪表：明确哪些能力可被外部任务调用。
 * - external-ready：可授予已配对外部调用方；
 * - requires-explicit-grant：永不在默认 grant 中，必须逐项显式授予；
 * - internal-only：仅 Profer 内部（same-session / same-instance）可用，不对外暴露。
 */
export const CAPABILITY_READINESS: Record<CapabilityValue, 'external-ready' | 'requires-explicit-grant' | 'internal-only'> = {
  [Capability.AGENT_EXECUTE]: 'internal-only',
  [Capability.TASK_SUBMIT]: 'external-ready',
  [Capability.TASK_READ]: 'external-ready',
  [Capability.TASK_CANCEL]: 'external-ready',
  [Capability.TASK_DELEGATE]: 'requires-explicit-grant',
  [Capability.TASK_APPROVE]: 'requires-explicit-grant',
  [Capability.WORKSPACE_READ]: 'external-ready',
  [Capability.WORKSPACE_WRITE]: 'requires-explicit-grant',
  [Capability.SHELL_RUN]: 'internal-only',
  [Capability.TEST_RUN]: 'internal-only',
  [Capability.RUNTIME_INSPECT]: 'external-ready',
  [Capability.RUNTIME_HEALTH]: 'external-ready',
  [Capability.RUNTIME_LOGS]: 'external-ready',
  [Capability.RUNTIME_RUN_SMOKE_TEST]: 'requires-explicit-grant',
  [Capability.RUNTIME_COLLECT_ARTIFACTS]: 'external-ready',
  [Capability.RUNTIME_RESTART]: 'requires-explicit-grant',
  [Capability.ARTIFACT_READ]: 'external-ready',
  [Capability.ARTIFACT_CREATE]: 'internal-only',
  [Capability.EXTERNAL_PUBLISH]: 'requires-explicit-grant',
}

/** 已配对外部 Agent（如 Hermes）的推荐默认 grant。 */
export const DEFAULT_PAIRED_AGENT_GRANTS: readonly CapabilityValue[] = [
  Capability.TASK_SUBMIT,
  Capability.TASK_READ,
  Capability.TASK_CANCEL,
  Capability.ARTIFACT_READ,
]

/**
 * 永不进入任何默认 grant 的能力。
 * 即使用户配对，也必须逐项显式勾选才授予。
 */
export const NEVER_DEFAULT_GRANTED: readonly CapabilityValue[] = [
  Capability.TASK_APPROVE,
  Capability.RUNTIME_RESTART,
  Capability.WORKSPACE_WRITE,
  Capability.EXTERNAL_PUBLISH,
]

/** 四级信任关系。loopback 不等于可信，信任级别参与能力解析。 */
export const TrustLevel = {
  SAME_SESSION: 'same-session',
  SAME_INSTANCE: 'same-instance',
  PAIRED_LOCAL_AGENT: 'paired-local-agent',
  UNTRUSTED_LOCAL: 'untrusted-local',
} as const

export type TrustLevelValue = (typeof TrustLevel)[keyof typeof TrustLevel]

const TRUST_RANK: Record<TrustLevelValue, number> = {
  [TrustLevel.UNTRUSTED_LOCAL]: 0,
  [TrustLevel.PAIRED_LOCAL_AGENT]: 1,
  [TrustLevel.SAME_INSTANCE]: 2,
  [TrustLevel.SAME_SESSION]: 3,
}

export function isTrustAtLeast(level: TrustLevelValue, required: TrustLevelValue): boolean {
  return TRUST_RANK[level] >= TRUST_RANK[required]
}

/** 能力解析输入：四层交集所需的前提。 */
export interface ResolveCapabilitiesInput {
  /** 调用方已被授予的能力（来自配对记录或会话内部身份）。 */
  callerGrants: readonly CapabilityValue[]
  /** 调用方信任级别。 */
  callerTrust: TrustLevelValue
  /** 目标节点声明支持的能力。 */
  nodeCapabilities: readonly CapabilityValue[]
  /** 任务 policy 进一步收窄的能力白名单；缺省表示不额外收窄。 */
  policyAllowedCapabilities?: readonly CapabilityValue[]
}

/**
 * 解析一次操作的有效能力交集。
 * internal-only 能力对 paired-local-agent 及更低信任级别直接剔除。
 */
export function resolveEffectiveCapabilities(input: ResolveCapabilitiesInput): Set<CapabilityValue> {
  const nodeSet = new Set(input.nodeCapabilities)
  const policySet = input.policyAllowedCapabilities ? new Set(input.policyAllowedCapabilities) : undefined
  const effective = new Set<CapabilityValue>()

  for (const cap of input.callerGrants) {
    if (!nodeSet.has(cap)) continue
    if (policySet && !policySet.has(cap)) continue
    const readiness = CAPABILITY_READINESS[cap]
    if (readiness === 'internal-only' && !isTrustAtLeast(input.callerTrust, TrustLevel.SAME_INSTANCE)) continue
    effective.add(cap)
  }
  return effective
}

/** 断言调用方当前对给定能力有有效授权，否则抛 CAPABILITY_DENIED。 */
export function assertCapability(input: ResolveCapabilitiesInput, required: CapabilityValue): void {
  if (!resolveEffectiveCapabilities(input).has(required)) {
    throw new ProtocolError(
      ProtocolErrorCode.CAPABILITY_DENIED,
      `调用方缺少有效能力 ${required}（grant ∩ 节点能力 ∩ 任务 policy 交集之外）`,
      { details: { required, callerTrust: input.callerTrust } },
    )
  }
}
