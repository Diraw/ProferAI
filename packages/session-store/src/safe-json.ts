import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  for (const candidate of [filePath, `${filePath}.tmp`, `${filePath}.bak`]) {
    try {
      const raw = await readFile(candidate, 'utf8')
      if (!raw.trim()) continue
      const parsed = JSON.parse(raw) as T
      if (candidate !== filePath) await writeJsonAtomic(filePath, parsed, true)
      return parsed
    } catch {
      // Try the next recovery candidate.
    }
  }
  return null
}

export async function writeJsonAtomic(filePath: string, data: unknown, skipBackup = false): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  if (!skipBackup) {
    try {
      await copyFile(filePath, `${filePath}.bak`)
    } catch {
      // A missing or unreadable previous file does not block the new write.
    }
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8')
  await rename(tempPath, filePath)
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
}
