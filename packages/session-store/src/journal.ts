import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SessionJournalOperation = 'delete' | 'fork' | 'rewind'
export type SessionJournalStatus = 'started' | 'committed' | 'failed'

export interface SessionOperationJournal {
  operationId: string
  operation: SessionJournalOperation
  sessionId: string
  status: SessionJournalStatus
  phase: string
  createdAt: number
  updatedAt: number
  destinationSessionId?: string
  sessionIds?: string[]
  error?: string
}

export function createSessionJournalStore(rootDir: string) {
  const pathFor = (operationId: string): string => `${rootDir}/${operationId}.json`

  const write = async (journal: SessionOperationJournal): Promise<void> => {
    await mkdir(dirname(pathFor(journal.operationId)), { recursive: true })
    await writeFile(pathFor(journal.operationId), JSON.stringify(journal, null, 2), 'utf8')
  }

  const read = async (operationId: string): Promise<SessionOperationJournal | undefined> => {
    try {
      return JSON.parse(await readFile(pathFor(operationId), 'utf8')) as SessionOperationJournal
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  const remove = async (operationId: string): Promise<void> => {
    try {
      await unlink(pathFor(operationId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return { pathFor, write, read, remove }
}
