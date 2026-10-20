import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionStorePaths } from './contracts'

const BLOCKED_NAMES = new Set([
  '.claude', '.DS_Store', '.git', 'node_modules', '.profer-pi-checkpoints',
  '.venv', 'venv', '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  '__pycache__', 'coverage', 'target',
])

export interface WorkspaceCopyResult {
  copiedCount: number
  skippedCount: number
  failedCount: number
  failedPaths: string[]
}

export async function copySessionWorkspace(
  sourceDir: string,
  destinationDir: string,
  onProgress?: (completed: number) => void,
): Promise<WorkspaceCopyResult> {
  await mkdir(destinationDir, { recursive: true })
  const result: WorkspaceCopyResult = { copiedCount: 0, skippedCount: 0, failedCount: 0, failedPaths: [] }
  let entries: string[]
  try {
    const { readdir } = await import('node:fs/promises')
    entries = await readdir(sourceDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  for (const entry of entries) {
    if (BLOCKED_NAMES.has(entry)) {
      result.skippedCount += 1
      continue
    }
    try {
      await cp(join(sourceDir, entry), join(destinationDir, entry), {
        recursive: true,
        force: true,
        filter: (source) => !BLOCKED_NAMES.has(source.slice(source.lastIndexOf('/') + 1)),
      })
      result.copiedCount += 1
      onProgress?.(result.copiedCount)
    } catch {
      result.failedCount += 1
      result.failedPaths.push(join(sourceDir, entry))
    }
  }
  return result
}

export async function removeSessionWorkspace(sessionDir: string): Promise<void> {
  await rm(sessionDir, { recursive: true, force: true })
}

export async function ensureSessionWorkspace(paths: SessionStorePaths, workspaceSlug: string, sessionId: string): Promise<string> {
  if (!paths.workspaceRoot) throw new Error('Session store workspaceRoot is not configured')
  const directory = join(paths.workspaceRoot, workspaceSlug, sessionId)
  await mkdir(dirname(directory), { recursive: true })
  await mkdir(directory, { recursive: true })
  return directory
}

export function sessionWorkspacePath(paths: SessionStorePaths, workspaceSlug: string, sessionId: string): string | undefined {
  return paths.workspaceRoot ? join(paths.workspaceRoot, workspaceSlug, sessionId) : undefined
}
