import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { parseEventsFromJsonl, type GraphEvent } from '@profer/project-core'
import type { SessionStorePaths } from './contracts'
import { removeFileIfExists } from './safe-json'
import { sessionGraphPath, sessionHarnessPath } from './paths'

export async function readGraphEvents(paths: SessionStorePaths, sessionId: string): Promise<GraphEvent[]> {
  return readJsonl(sessionGraphPath(paths, sessionId)) as Promise<GraphEvent[]>
}

export async function appendGraphEvents(paths: SessionStorePaths, sessionId: string, events: readonly GraphEvent[]): Promise<void> {
  await appendJsonl(sessionGraphPath(paths, sessionId), events)
}

export async function replaceGraphEvents(paths: SessionStorePaths, sessionId: string, events: readonly GraphEvent[]): Promise<void> {
  await replaceJsonl(sessionGraphPath(paths, sessionId), events)
}

export async function readHarnessEvents(paths: SessionStorePaths, sessionId: string): Promise<unknown[]> {
  return readJsonl(sessionHarnessPath(paths, sessionId))
}

export async function appendHarnessEvents(paths: SessionStorePaths, sessionId: string, events: readonly unknown[]): Promise<void> {
  await appendJsonl(sessionHarnessPath(paths, sessionId), events)
}

export async function replaceHarnessEvents(paths: SessionStorePaths, sessionId: string, events: readonly unknown[]): Promise<void> {
  await replaceJsonl(sessionHarnessPath(paths, sessionId), events)
}

export async function removeSessionEventFiles(paths: SessionStorePaths, sessionId: string): Promise<void> {
  await Promise.all([
    removeFileIfExists(sessionGraphPath(paths, sessionId)),
    removeFileIfExists(sessionHarnessPath(paths, sessionId)),
  ])
}

export async function copyGraphEventsThroughTimestamp(
  paths: SessionStorePaths,
  sourceSessionId: string,
  destinationSessionId: string,
  timestamp: number,
): Promise<number> {
  const source = await readFileIfExists(sessionGraphPath(paths, sourceSessionId))
  if (!source) return 0
  const events = parseEventsFromJsonl(source).filter((event) => event.timestamp <= timestamp)
  if (events.length === 0) return 0
  await replaceGraphEvents(paths, destinationSessionId, events)
  return events.length
}

export async function copyHarnessEventsThroughTimestamp(
  paths: SessionStorePaths,
  sourceSessionId: string,
  destinationSessionId: string,
  timestamp: number,
): Promise<number> {
  const source = await readFileIfExists(sessionHarnessPath(paths, sourceSessionId))
  if (!source) return 0
  const events = source.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line) as { timestamp?: unknown }
      return typeof value.timestamp === 'number' && value.timestamp <= timestamp ? [value] : []
    } catch {
      return []
    }
  })
  if (events.length === 0) return 0
  await replaceHarnessEvents(paths, destinationSessionId, events)
  return events.length
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}


async function appendJsonl(filePath: string, values: readonly unknown[]): Promise<void> {
  if (values.length === 0) return
  await mkdir(pathsDir(filePath), { recursive: true })
  await appendFile(filePath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8')
}

async function replaceJsonl(filePath: string, values: readonly unknown[]): Promise<void> {
  await mkdir(pathsDir(filePath), { recursive: true })
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, values.length ? `${values.map((value) => JSON.stringify(value)).join('\n')}\n` : '', 'utf8')
  await rename(temp, filePath)
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  try {
    const content = await readFile(filePath, 'utf8')
    const result: unknown[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        result.push(JSON.parse(line))
      } catch {
        // Ignore a malformed record and keep valid history.
      }
    }
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function pathsDir(filePath: string): string {
  return filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')))
}
