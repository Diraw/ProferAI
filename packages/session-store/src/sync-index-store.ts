import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { normalizeSessionIndexData } from '@profer/session-core'
import type { AgentSessionsIndex, SyncSessionIndexStore } from './contracts'

const INDEX_VERSION = 1

export function createSyncSessionIndexStore(getPath: () => string): SyncSessionIndexStore {
  let cache: { data: AgentSessionsIndex; mtimeMs: number; size: number } | null = null

  const cacheIndex = (data: AgentSessionsIndex): void => {
    try {
      const info = statSync(getPath())
      cache = { data, mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      cache = null
    }
  }

  const writeAtomic = (filePath: string, data: unknown, skipBackup = false): void => {
    const directory = dirname(filePath)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    if (!skipBackup && existsSync(filePath)) {
      try { copyFileSync(filePath, `${filePath}.bak`) } catch { /* backup is best effort */ }
    }
    const tempPath = `${filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tempPath, filePath)
  }

  const readSafe = (): AgentSessionsIndex | null => {
    for (const candidate of [getPath(), `${getPath()}.tmp`, `${getPath()}.bak`]) {
      if (!existsSync(candidate)) continue
      try {
        const raw = readFileSync(candidate, 'utf8')
        if (!raw.trim()) continue
        const parsed = JSON.parse(raw) as AgentSessionsIndex
        if (candidate !== getPath()) writeAtomic(getPath(), parsed, true)
        return parsed
      } catch {
        if (candidate.endsWith('.tmp')) {
          try { unlinkSync(candidate) } catch { /* ignore */ }
        }
      }
    }
    return null
  }

  const read = (): AgentSessionsIndex => {
    const filePath = getPath()
    if (cache) {
      try {
        const info = statSync(filePath)
        if (info.mtimeMs === cache.mtimeMs && info.size === cache.size) return cache.data
      } catch {
        cache = null
      }
    }
    const normalized = normalizeSessionIndexData(readSafe())
    if (normalized.removedLegacyKnowledgeReferences) {
      try { writeAtomic(filePath, normalized.index) } catch { cache = null; return normalized.index }
    }
    cacheIndex(normalized.index)
    return normalized.index
  }

  const write = (index: AgentSessionsIndex): void => {
    try {
      writeAtomic(getPath(), index)
      cacheIndex(index)
    } catch (error) {
      cache = null
      throw new Error('写入 Agent 会话索引失败', { cause: error })
    }
  }

  return {
    read,
    write,
    list: (includeArchived = false) => read().sessions
      .filter((session) => includeArchived || !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    countArchived: () => read().sessions.filter((session) => session.archived && !session.draft).length,
    get: (sessionId) => read().sessions.find((session) => session.id === sessionId),
  }
}

export type { AgentSessionMeta }
