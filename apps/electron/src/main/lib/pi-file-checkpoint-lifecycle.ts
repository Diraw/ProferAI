/**
 * pi-file-checkpoint-lifecycle — Pi 文件回退检查点的**宿主持有**生命周期（GAP-2 / 原 B-3）
 *
 * 背景：
 * - 旧路径把检查点生命周期写在 `agent-orchestrator.ts` 里：每轮开始前
 *   `createPiFileCheckpoint(sessionId, agentCwd, getPiCheckpointsDir())`（try/catch，失败只告警），
 *   然后在 `onPiEntryBindings(bindings)` 回调里把本轮检查点绑定到 assistant entry、顺带 prune/keep。
 * - 新 runtime 路径（coordinator）**没有**任何 checkpoint 概念，
 *   `agent-runtime-native-session-persistence.ts` 只提供 `resolveCheckpointPatch` 的**注入位**。
 *
 * 本模块就是那个「宿主持有并注入」的实现：把创建 / 绑定 / 回收 / keep 规则从旧编排器内部
 * 抽出来，只依赖 `pi-file-checkpoint.ts` 的纯函数与宿主的会话索引，不 import 编排器。
 *
 * 三条必须保持的语义（与旧链逐条对齐）：
 * 1. **创建失败不得阻断本轮运行**：文件回退是增强能力，磁盘 / 权限 / 第三方文件锁异常
 *    绝不能中断模型请求（旧实现把创建包在 try/catch 内，只打警告）。
 * 2. **仅在真正的 pi 会话上创建**：`cwd` 缺失时跳过（无工作区就没有可回退的文件面）。
 * 3. **回收失败同样不得阻断**：prune 只做机会式 GC，抛错时保留既有映射并继续本轮。
 *
 * 调用顺序（重要）：`beginPiCheckpointTurn()` 必须在**本轮 provider 启动之前**调用，
 * 否则快照到的不是本轮改动前的工作区基线。绑定（`resolveCheckpointPatch`）发生在 provider
 * 流中的 `onPiEntryBindings` 回调，因此天然晚于创建。
 */

import type { AgentSessionMeta } from '@profer/shared'
import { getPiCheckpointsDir } from './config-paths'
import { collectForeignCheckpointPaths } from './agent-session-manager'
import {
  createPiFileCheckpoint,
  prunePiFileCheckpoints,
  type PiCheckpointOptions,
} from './pi-file-checkpoint'

/** 检查点生命周期日志出口；默认只打 console.warn（与旧链的告警级别一致）。 */
export interface PiCheckpointLifecycleLogger {
  warn(message: string, error?: unknown): void
  log?(message: string): void
}

export interface PiCheckpointTurnDeps {
  sessionId: string
  /** 本轮快照的工作区根目录（旧编排器的 `agentCwd`）。 */
  cwd: string
  /** 检查点根目录；缺省 = `getPiCheckpointsDir()`（`~/.profer/agent-checkpoints/`）。 */
  rootDir?: string
  /** 引擎 / 体积上限覆盖，透传 `createPiFileCheckpoint`。 */
  checkpointOptions?: PiCheckpointOptions
  /**
   * 跨会话保护：分叉会话可能仍在引用本会话目录里的检查点（迁移失败 / 旧数据），
   * 这些路径必须进入 keep 集合，否则会把分叉侧的回退点删掉。
   * 缺省 = 会话索引里的 `collectForeignCheckpointPaths`。
   */
  collectForeignPaths?: (excludeSessionId: string) => Iterable<string>
  /** 创建实现（测试注入用）。缺省 = 真实 `createPiFileCheckpoint`。 */
  createCheckpoint?: typeof createPiFileCheckpoint
  /** 回收实现（测试注入用）。缺省 = 真实 `prunePiFileCheckpoints`。 */
  pruneCheckpoints?: typeof prunePiFileCheckpoints
  logger?: PiCheckpointLifecycleLogger
}

export interface PiCheckpointPatchInput {
  /** provider 回调给出的 assistant UUID → Pi entry ID 映射。 */
  bindings: Record<string, string>
  /** 当前会话元数据（读取既有 `piFileCheckpoints`）。 */
  meta: AgentSessionMeta | undefined
}

export interface PiCheckpointTurn {
  /** 本轮是否成功创建了检查点。false = 本轮不可文件回退，但运行继续。 */
  readonly created: boolean
  /** 本轮检查点路径（created === false 时缺省）。 */
  readonly path?: string
  /**
   * 供 `createNativeSessionPersister({ resolveCheckpointPatch })` 注入的补丁函数。
   *
   * - `created === false`：返回 `undefined`，**不触碰** `piFileCheckpoints`
   *   （与旧链 `...(piTurnCheckpoint ? { piFileCheckpoints } : {})` 一致）；
   * - `created === true`：把 bindings 里的每个 entry 绑定到本轮检查点，回收无人引用的旧条目，
   *   并从映射里摘掉被回收的路径（被删的回退点必须明确降级，而不是静默失效）。
   */
  resolveCheckpointPatch(input: PiCheckpointPatchInput): Partial<AgentSessionMeta> | undefined
}

const noopLogger: PiCheckpointLifecycleLogger = { warn: () => {} }

/**
 * 开始一轮检查点生命周期：本轮开始前创建基线快照，并返回绑定/回收补丁函数。
 *
 * 不抛错：任何失败都降级为「本轮不可文件回退」，返回值里的 `created` 如实反映结果。
 */
export function beginPiCheckpointTurn(deps: PiCheckpointTurnDeps): PiCheckpointTurn {
  const logger = deps.logger ?? noopLogger
  const createCheckpoint = deps.createCheckpoint ?? createPiFileCheckpoint
  const pruneCheckpoints = deps.pruneCheckpoints ?? prunePiFileCheckpoints
  const collectForeign = deps.collectForeignPaths ?? collectForeignCheckpointPaths

  let rootDir: string | undefined
  let turnPath: string | undefined

  try {
    rootDir = deps.rootDir ?? getPiCheckpointsDir()
    turnPath = createCheckpoint(deps.sessionId, deps.cwd, rootDir, deps.checkpointOptions ?? {}).path
  } catch (error) {
    // 语义 1：检查点失败不得阻断本轮运行。
    logger.warn(`Pi 文件检查点创建失败，本轮继续但不可文件回退 (${deps.sessionId}):`, error)
    return {
      created: false,
      resolveCheckpointPatch: () => undefined,
    }
  }

  if (!turnPath) {
    logger.warn(`Pi 文件检查点创建返回空路径，本轮不可文件回退 (${deps.sessionId})`)
    return {
      created: false,
      resolveCheckpointPatch: () => undefined,
    }
  }

  const checkpointPath = turnPath
  const checkpointRoot = rootDir as string

  return {
    created: true,
    path: checkpointPath,
    resolveCheckpointPatch({ bindings, meta }) {
      const checkpoints = { ...(meta?.piFileCheckpoints ?? {}) }
      for (const entryId of Object.values(bindings)) checkpoints[entryId] = checkpointPath

      // keep 集合 = 既有绑定 + 本轮快照 + 跨会话仍在引用的路径。
      // 本轮新快照无论如何都在保留集内：bindings 为空时也不能把自己当孤儿删掉。
      const keepPaths = new Set(Object.values(checkpoints))
      keepPaths.add(checkpointPath)
      try {
        for (const foreign of collectForeign(deps.sessionId)) keepPaths.add(foreign)
      } catch (error) {
        logger.warn(`收集跨会话检查点引用失败，按本会话范围回收 (${deps.sessionId}):`, error)
      }

      let removed = new Set<string>()
      try {
        removed = new Set(pruneCheckpoints(checkpointRoot, deps.sessionId, { keepPaths }).removed)
      } catch (error) {
        // 语义 3：回收失败不阻断，保留既有映射（宁可多占盘，不可丢回退点）。
        logger.warn(`回收 Pi 文件检查点失败，保留既有映射 (${deps.sessionId}):`, error)
        return { piFileCheckpoints: checkpoints }
      }

      const keptCheckpoints = removed.size > 0
        ? Object.fromEntries(
            Object.entries(checkpoints).filter(([, mappedPath]) => !removed.has(mappedPath)),
          )
        : checkpoints

      return { piFileCheckpoints: keptCheckpoints }
    },
  }
}
