import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { copyForkPath, describeForkFileError } from './fork-file-ops'

const FORK_WORKSPACE_COPY_BLOCKLIST = new Set([
  '.claude',
  '.DS_Store',
  '.git',
  'node_modules',
  // Pi 检查点：每轮一份全量快照，且现已存放在配置目录下；
  // 历史会话残留在 cwd 内的旧检查点也不应随分叉复制一遍
  '.profer-pi-checkpoints',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '__pycache__',
  'coverage',
  'target',
])

export interface ForkWorkspaceCopyResult {
  copiedCount: number
  skippedCount: number
  failedCount: number
  failedPaths: Array<{ path: string; reason: string }>
}

export function shouldCopyForkWorkspacePath(src: string): boolean {
  return !FORK_WORKSPACE_COPY_BLOCKLIST.has(basename(src))
}

export function copyForkWorkspaceFiles(sourceDir: string, destDir: string): ForkWorkspaceCopyResult {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  const result: ForkWorkspaceCopyResult = {
    copiedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    failedPaths: [],
  }

  let entries: Array<{ name: string }>
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true, encoding: 'utf8' }) as Array<{ name: string }>
  } catch (error) {
    result.failedCount += 1
    result.failedPaths.push({ path: sourceDir, reason: describeForkFileError(error) })
    console.warn(`[Agent 会话] fork 工作区目录读取失败，已跳过 (${sourceDir}):`, error)
    return result
  }
  for (const entry of entries) {
    const srcPath = join(sourceDir, entry.name)
    const destPath = join(destDir, entry.name)

    if (!shouldCopyForkWorkspacePath(srcPath)) {
      result.skippedCount += 1
      continue
    }

    try {
      copyForkPath(srcPath, destPath, {
        recursive: true,
        filter: shouldCopyForkWorkspacePath,
      })
      result.copiedCount += 1
    } catch (err) {
      result.failedCount += 1
      result.failedPaths.push({ path: srcPath, reason: describeForkFileError(err) })
      console.warn(`[Agent 会话] fork 工作区条目复制失败，已跳过 (${srcPath}):`, err)
    }
  }

  return result
}
