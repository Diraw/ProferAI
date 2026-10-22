import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionStorePaths } from './contracts'

const HASH_PREFIX = 'sha256:'

export interface StoredBlobRef {
  hash: string
  bytes: number
}

export function hashBlob(content: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

export function blobPath(paths: SessionStorePaths, hash: string): string {
  const hex = hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : hash
  return join(paths.blobsDir, hex.slice(0, 2), hex.slice(2, 4), hex)
}

export async function writeBlob(paths: SessionStorePaths, content: string): Promise<StoredBlobRef> {
  const hash = hashBlob(content)
  const destination = blobPath(paths, hash)
  try {
    await readFile(destination)
  } catch {
    await mkdir(dirname(destination), { recursive: true })
    const temp = `${destination}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, content, 'utf8')
    await rename(temp, destination)
  }
  return { hash, bytes: Buffer.byteLength(content, 'utf8') }
}

export async function readBlob(paths: SessionStorePaths, hash: string): Promise<string | null> {
  try {
    const content = await readFile(blobPath(paths, hash), 'utf8')
    return hashBlob(content) === hash ? content : null
  } catch {
    return null
  }
}
