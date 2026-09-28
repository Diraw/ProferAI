/**
 * Artifact 与 Result 契约
 *
 * 核心原则：结论（Result）和证据（Evidence / Artifact）分开。
 * 产物不通过任意路径暴露：Gateway 只返回引用与元数据，
 * 内容读取要再次校验调用方、任务关系、workspace scope、大小与有效期。
 */

import { ProtocolError, ProtocolErrorCode } from './protocol'

export const ArtifactKind = {
  LOG: 'log',
  SCREENSHOT: 'screenshot',
  TEST_REPORT: 'test-report',
  DIFF: 'diff',
  PATCH: 'patch',
  OTHER: 'other',
} as const

export type ArtifactKindValue = (typeof ArtifactKind)[keyof typeof ArtifactKind]

/** 产物引用：只含元数据，不含内容与文件系统路径。 */
export interface ArtifactRef {
  artifactId: string
  taskId: string
  kind: ArtifactKindValue
  mimeType?: string
  sizeBytes?: number
  createdAt: number
  expiresAt?: number
  /** 人类可读说明（如截图页面、测试范围）。 */
  label?: string
}

/** 产物读取前置校验：过期立即拒绝。 */
export function assertArtifactReadable(ref: ArtifactRef, now: number = Date.now()): void {
  if (ref.expiresAt !== undefined && ref.expiresAt <= now) {
    throw new ProtocolError(
      ProtocolErrorCode.ARTIFACT_EXPIRED,
      `产物 ${ref.artifactId} 已过期（${new Date(ref.expiresAt).toISOString()}），按生命周期策略拒绝读取`,
    )
  }
}

// ===== 结果与证据 =====

export const EvidenceType = {
  COMMAND: 'command',
  LOG: 'log',
  SCREENSHOT: 'screenshot',
  DIFF: 'diff',
  RUNTIME_EVENT: 'runtime-event',
} as const

export type EvidenceTypeValue = (typeof EvidenceType)[keyof typeof EvidenceType]

/** 证据是对执行记录/产物的引用，不是内联内容本体。 */
export interface Evidence {
  type: EvidenceTypeValue
  /** 指向 executionId 或 artifactId。 */
  ref: string
}

export interface TaskTestResult {
  command: string
  exitCode: number
  passed: number
  failed: number
  artifactId?: string
}

/**
 * 结构化任务结论。
 * status 是机器判定字段；summary 面向人，不作为状态来源。
 */
export interface TaskResult {
  status: 'completed' | 'failed' | 'cancelled' | 'expired'
  summary: string
  changedFiles: readonly string[]
  testResults: readonly TaskTestResult[]
  artifacts: readonly ArtifactRef[]
  evidence: readonly Evidence[]
  blockers: readonly string[]
  nextActions: readonly string[]
}

/**
 * 结果一致性检查：把“自称成功”和证据对不上的情况显式暴露出来。
 * 返回问题列表；为空表示一致。这是契约级防“测试通过”式虚报的最低线。
 */
export function findResultInconsistencies(result: TaskResult): string[] {
  const issues: string[] = []
  const failedTests = result.testResults.filter((test) => test.exitCode !== 0 || test.failed > 0)

  if (result.status === 'completed') {
    if (result.blockers.length > 0) {
      issues.push(`status=completed 但存在 ${result.blockers.length} 条 blocker`)
    }
    if (failedTests.length > 0) {
      issues.push(
        `status=completed 但有 ${failedTests.length} 条测试失败（${failedTests.map((test) => test.command).join('；')}）`,
      )
    }
  }
  if (result.status === 'failed' && result.blockers.length === 0 && failedTests.length === 0) {
    issues.push('status=failed 但既没有 blocker 也没有失败测试，缺少可定位的失败原因')
  }
  return issues
}
