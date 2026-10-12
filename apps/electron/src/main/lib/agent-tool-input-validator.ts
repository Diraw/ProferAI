/**
 * 工具参数校验模块
 *
 * 在 canUseTool 回调中拦截参数缺失的工具调用，
 * 返回描述性 deny message 引导模型重试。
 */

import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 已知工具的必需参数映射（使用权限层 canonical 字段名） */
export const TOOL_REQUIRED_PARAMS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['Write', ['file_path', 'content']],
  ['Edit', ['file_path', 'old_string', 'new_string']],
  ['MultiEdit', ['file_path', 'old_string', 'new_string']],
  ['Bash', ['command']],
  ['Read', ['file_path']],
  ['Glob', ['pattern']],
  ['Grep', ['pattern']],
  ['Agent', ['prompt', 'description']],
])

function canonicalToolName(toolName: string): string {
  return toolName === 'MultiEdit' ? 'Edit' : toolName
}

/** 会把第一个参数当作文件系统路径的工具（Claude canonical 名、Pi 显示名与 Pi 原生小写名）。 */
const FILESYSTEM_PATH_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'LS',
  'Ls',
  'Glob',
  'Grep',
  'read',
  'write',
  'edit',
  'ls',
  'glob',
  'grep',
  'find',
])

/** 形如 `C:\Users\…` / `C:/Users/…` 的 Windows 盘符绝对路径。 */
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/

/**
 * 拒绝在非 Windows 平台上传入的 Windows 绝对路径。
 *
 * `node:path.isAbsolute('C:\\Users\\alex\\dev')` 在 macOS/Linux 上返回 false，
 * 于是路径被当成相对路径拼到会话工作目录后面（`…/session/C:\Users\alex\dev`），
 * 生成形状正确、实际不存在的伪路径。模型看不出自己写错了什么，只会得出
 * 「文件不存在」的错误结论。
 *
 * 这里在共享权限边界（两套 runtime 的 canUseTool）统一拦截，模型在写错平台路径的
 * 当轮就能得到明确纠正，而不是拿到一条语义误导的 ENOENT。
 */
export function validateToolPathPlatform(
  toolName: string,
  input: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): ToolValidationFailure | null {
  // Windows 上盘符路径是合法绝对路径，不能拦。
  if (platform === 'win32') return null

  const canonical = canonicalToolName(toolName)
  if (!FILESYSTEM_PATH_TOOLS.has(canonical) && !FILESYSTEM_PATH_TOOLS.has(toolName)) return null

  const rawPath = input.file_path ?? input.path
  if (typeof rawPath !== 'string') return null

  const trimmed = rawPath.trim()
  if (!WINDOWS_DRIVE_PATH.test(trimmed)) return null

  return {
    behavior: 'deny',
    message:
      `Path "${trimmed}" is a Windows absolute path, but this session runs on ${platform}, ` +
      'where it is not absolute and would be resolved relative to the session directory. ' +
      'Use the real POSIX path under the current workspace, or list the target directory first to confirm where things actually live.',
  }
}

function firstPiEdit(input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(input.edits)) return undefined
  return input.edits.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}

/**
 * 将 Claude/Profer canonical 输入和 Pi 原生输入统一到权限校验形状。
 *
 * Pi 的内置 Edit 使用 path + edits[].oldText/newText；权限服务则统一使用
 * file_path + old_string/new_string。这里必须在必需参数校验前完成归一化，
 * 不能把 Pi 的合法参数误判为缺少 Claude 字段。
 */
export function normalizeToolInputForValidation(
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown>; missingNested?: string[] } {
  const canonicalName = canonicalToolName(toolName)
  if (canonicalName === 'Read' || canonicalName === 'Write') {
    return {
      toolName: canonicalName,
      input: { ...input, file_path: input.file_path ?? input.path },
    }
  }

  if (canonicalName !== 'Edit') {
    return { toolName: canonicalName, input }
  }

  // 只有出现 `edits` 字段时才按 Pi 原生 Edit 处理；没有该字段的输入是
  // Claude/Profer canonical 的单编辑格式，不应被误判为缺少 Pi edits。
  if (!Object.prototype.hasOwnProperty.call(input, 'edits')) {
    return {
      toolName: canonicalName,
      input: { ...input, file_path: input.file_path ?? input.path },
    }
  }

  const editItems = Array.isArray(input.edits)
    ? input.edits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
  if (editItems.length === 0) {
    return {
      toolName: canonicalName,
      input: { ...input, file_path: input.file_path ?? input.path },
      missingNested: ['edits'],
    }
  }

  const first = firstPiEdit(input) ?? editItems[0]
  const missingNested = editItems.flatMap((edit, index) => [
    (edit.old_string ?? edit.oldText) === undefined || (edit.old_string ?? edit.oldText) === ''
      ? `edits[${index}].oldText`
      : '',
    // 空 newText 是合法操作，表示删除匹配到的文本；这里只检查字段是否存在。
    (edit.new_string ?? edit.newText) === undefined
      ? `edits[${index}].newText`
      : '',
  ].filter(Boolean))

  return {
    toolName: canonicalName,
    input: {
      ...input,
      file_path: input.file_path ?? input.path,
      old_string: input.old_string ?? first?.old_string ?? first?.oldText,
      new_string: input.new_string ?? first?.new_string ?? first?.newText,
    },
    ...(missingNested.length > 0 && { missingNested }),
  }
}

/** 校验失败结果，与 PermissionResult deny 形状一致 */
export interface ToolValidationFailure {
  behavior: 'deny'
  message: string
}

/**
 * Write 工具不能隐式创建父目录。Pi SDK 默认会对父目录执行 mkdir({ recursive: true })，
 * 所以必须在两套 runtime 的共享权限边界先拒绝不存在的父目录。
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

/** 校验工具调用的必需参数是否存在且非空。 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>,
): ToolValidationFailure | null {
  const normalized = normalizeToolInputForValidation(toolName, input)
  const requiredParams = TOOL_REQUIRED_PARAMS.get(normalized.toolName)
  if (!requiredParams) return null

  const missing: string[] = [...(normalized.missingNested ?? [])]
  for (const param of requiredParams) {
    const value = normalized.input[param]
    // Edit/Write 允许空字符串作为有效内容（分别表示删除替换内容和创建空文件）；
    // 真正缺失只包括 undefined/null。Bash 等字符串参数仍拒绝空白命令。
    if (value === undefined || value === null || (param === 'command' && typeof value === 'string' && value.trim() === '')) {
      missing.push(param)
    }
  }

  if (missing.length === 0) return null

  const uniqueMissing = [...new Set(missing)]
  const paramList = uniqueMissing.map((p) => `"${p}"`).join(', ')
  const message = uniqueMissing.some((param) => param.startsWith('edits['))
    ? `Tool "${toolName}" has invalid Pi Edit input: ${paramList}. Please retry after re-reading the current file and provide path + edits[].oldText/newText; do not reuse oldText from a failed call.`
    : uniqueMissing.length === 1
      ? `Tool "${toolName}" is missing required parameter ${paramList}. Please retry with all required parameters filled in.`
      : `Tool "${toolName}" is missing required parameters: ${paramList}. Please retry with all required parameters filled in.`

  return { behavior: 'deny' as const, message }
}
