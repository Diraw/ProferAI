import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 校验失败结果，与权限 deny 结果形状一致。 */
export interface ToolValidationFailure {
  behavior: 'deny'
  message: string
}

/**
 * Write 工具父目录前置校验：**唯一实现**（GAP-7 E2 去重后）。
 *
 * 为什么落在这里（而不是 runtime 核心或 apps/electron）：
 * 1. 该函数用 `node:fs.statSync` 与 `process.cwd()`，**不是纯函数**，把它塞进
 *    `@profer/agent-runtime` 的根入口会把文件系统行为带进宿主无关的 runtime 契约；
 * 2. `packages/*` 不得反向导入 `apps/*`（check-boundaries R2），因此实现只能在包里；
 * 3. 包内已有 `@profer/agent-provider-claude/background-task-manager`、`agent-sdk-auth-env`
 *    这类「宿主共用、由 provider 包持有并被宿主兼容转发」的先例。
 *
 * 消费方：
 * - Claude SDK 的 PreToolUse hook（本包 `claude-agent-adapter.ts`）；
 * - Electron 宿主的两套 runtime 共享权限边界：
 *   `apps/electron/src/main/lib/agent-tool-input-validator.ts` 直接转发本模块，不再保留副本。
 *
 * 语义：Write 工具不能隐式创建父目录。Pi SDK 默认会对父目录执行 mkdir({ recursive: true })，
 * 所以必须在共享权限边界先拒绝不存在的父目录。
 */
export function validateWriteTargetParent(
  input: Record<string, unknown>,
  cwd: string | undefined,
  toolName = 'Write',
): ToolValidationFailure | null {
  if (toolName !== 'Write') return null

  const rawPath = input.file_path ?? input.path
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null

  const targetPath = resolve(cwd ?? process.cwd(), rawPath)
  const parentPath = dirname(targetPath)
  try {
    if (statSync(parentPath).isDirectory()) return null
  } catch {
    // 统一返回“父目录不存在”，避免把 ENOENT/ENOTDIR 细节泄露给模型。
  }

  return {
    behavior: 'deny',
    message: `${toolName} target parent directory does not exist: ${parentPath}. Create the directory explicitly first, then retry the file write. Profer will not create parent directories implicitly.`,
  }
}
