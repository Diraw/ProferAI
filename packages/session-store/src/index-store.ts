import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeSessionIndexData } from '@profer/session-core'
import type { AgentSessionsIndex, SessionIndexStore, SessionStorePaths } from './contracts'

const INDEX_VERSION = 1

interface CacheEntry {
  data: AgentSessionsIndex
  mtimeMs: number
  size: number
}

export function createSessionIndexStore(paths: SessionStorePaths): SessionIndexStore {
  let cache: CacheEntry | null = null
  let writeTail: Promise<void> = Promise.resolve()

  const writeAtomic = async (filePath: string, data: unknown, skipBackup = false): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true })
    if (!skipBackup) {
      try { await copyFile(filePath, `${filePath}.bak`) } catch { /* 备份失败不阻断索引写入 */ }
    }
    await writeFile(`${filePath}.tmp`, JSON.stringify(data, null, 2), 'utf8')
    await rename(`${filePath}.tmp`, filePath)
  }

  const readSafe = async (): Promise<AgentSessionsIndex | null> => {
    for (const candidate of [paths.sessionsIndex, `${paths.sessionsIndex}.tmp`, `${paths.sessionsIndex}.bak`]) {
      try {
        const raw = await readFile(candidate, 'utf8')
        if (!raw.trim()) continue
        const parsed = JSON.parse(raw) as AgentSessionsIndex
        if (candidate !== paths.sessionsIndex) await writeAtomic(paths.sessionsIndex, parsed, true)
        return parsed
      } catch {
        // Try the next recovery candidate.
      }
    }
    return null
  }

  const cacheIndex = async (data: AgentSessionsIndex): Promise<void> => {
    try {
      const info = await stat(paths.sessionsIndex)
      cache = { data, mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      cache = null
    }
  }

  const read = async (): Promise<AgentSessionsIndex> => {
    if (cache) {
      try {
        const info = await stat(paths.sessionsIndex)
        if (info.mtimeMs === cache.mtimeMs && info.size === cache.size) return cache.data
      } catch {
        cache = null
      }
    }
    const normalized = normalizeSessionIndexData(await readSafe())
    if (normalized.removedLegacyKnowledgeReferences) {
      try { await writeAtomic(paths.sessionsIndex, normalized.index) } catch { cache = null }
    }
    await cacheIndex(normalized.index)
    return normalized.index
  }

  const write = async (index: AgentSessionsIndex): Promise<void> => {
    const next = writeTail.then(async () => {
      try {
        await writeAtomic(paths.sessionsIndex, index)
        await cacheIndex(index)
      } catch (error) {
        cache = null
        throw new Error('写入 Agent 会话索引失败', { cause: error })
      }
    })
    writeTail = next.catch(() => {})
    return next
  }

  return {
    read,
    write,
    list: async (includeArchived = false) => (await read()).sessions
      .filter((session) => includeArchived || !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    countArchived: async () => (await read()).sessions.filter((session) => session.archived && !session.draft).length,
    get: async (sessionId) => (await read()).sessions.find((session) => session.id === sessionId),
  }
}
