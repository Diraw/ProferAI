import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, rename, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { SDKMessage } from '@profer/shared'
import { readSessionMessagesFromString } from '@profer/session-core'
import type { SessionFileStore, SessionStorePaths } from './contracts'
import { removeFileIfExists } from './safe-json'
import { removeSessionEventFiles } from './event-store'
import { sessionMessagesPath } from './paths'

export function createSessionFileStore(paths: SessionStorePaths): SessionFileStore {
  const remove = async (sessionId: string): Promise<void> => {
    await Promise.all([
      removeFileIfExists(sessionMessagesPath(paths, sessionId)),
      removeSessionEventFiles(paths, sessionId),
    ])
  }

  const copy = async (
    sourceSessionId: string,
    destinationSessionId: string,
    options: {
      upToMessageUuid?: string
      transformMessage?: (message: SDKMessage) => SDKMessage
      serializeMessage?: (message: SDKMessage) => string
      onProgress?: (completed: number) => void
    } = {},
  ): Promise<number> => {
    const sourcePath = sessionMessagesPath(paths, sourceSessionId)
    const destinationPath = sessionMessagesPath(paths, destinationSessionId)
    const endIndex = options.upToMessageUuid
      ? await findMessageIndex(sourcePath, options.upToMessageUuid)
      : (await lineCount(sourcePath)) - 1
    await mkdir(paths.sessionsDir, { recursive: true })
    const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`
    const input = createInterface({ input: createReadStream(sourcePath, { encoding: 'utf8' }), crlfDelay: Infinity })
    const output = createWriteStream(tempPath, { encoding: 'utf8' })
    let lineIndex = 0
    let copied = 0
    try {
      for await (const line of input) {
        if (!line.trim()) continue
        if (lineIndex > endIndex) break
        lineIndex += 1
        const parsed = readSessionMessagesFromString(line)[0]
        if (!parsed) continue
        const message = options.transformMessage ? options.transformMessage(parsed) : parsed
        const serialized = options.serializeMessage?.(message) ?? JSON.stringify(message)
        await new Promise<void>((resolveWrite, reject) => {
          output.write(`${serialized}\n`, (error) => error ? reject(error) : resolveWrite())
        })
        copied += 1
        options.onProgress?.(copied)
      }
      await new Promise<void>((resolveEnd, reject) => {
        output.once('error', reject)
        output.end(resolveEnd)
      })
      await rename(tempPath, destinationPath)
    } catch (error) {
      input.close()
      output.destroy()
      await removeFileIfExists(tempPath)
      throw error
    }
    return copied
  }

  return { remove, copy }
}

async function lineCount(filePath: string): Promise<number> {
  let count = 0
  const input = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of input) if (line.trim()) count += 1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return count
}

async function findMessageIndex(filePath: string, uuid: string): Promise<number> {
  let index = 0
  const input = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of input) {
      if (!line.trim()) continue
      const message = readSessionMessagesFromString(line)[0] as { uuid?: string } | undefined
      if (message?.uuid === uuid) return index
      index += 1
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return -1
}

export async function copySessionArtifactFile(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(destinationPath.slice(0, Math.max(destinationPath.lastIndexOf('/'), destinationPath.lastIndexOf('\\'))), { recursive: true })
  await cp(sourcePath, destinationPath, { recursive: true, force: true })
}

export async function getSessionFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}
