import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
export interface TokenMigrationIO {
  exists(path: string): boolean
  read(path: string): string
  atomic(path: string, value: unknown): void
  remove(path: string): void
}
const io: TokenMigrationIO = {
  exists: existsSync, read: (p) => readFileSync(p, 'utf8'), remove: unlinkSync,
  atomic: (path, value) => { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp`; writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, path) },
}
interface TokenFile { token?: string; encrypted?: string; pendingCleanup?: string }
export function migrateRemoteToken(target: string, legacy: string, protect: (s: string) => string, reveal: (s: string) => string, fs: TokenMigrationIO = io): string {
  const different = resolve(target) !== resolve(legacy)
  const source = fs.exists(target) ? target : different && fs.exists(legacy) ? legacy : target
  const saved = fs.exists(source) ? JSON.parse(fs.read(source)) as TokenFile : {}
  if (saved.token !== undefined && (typeof saved.token !== 'string' || !saved.token)) throw new Error('旧远控凭据文件损坏')
  const token = saved.encrypted ? reveal(saved.encrypted) : saved.token || randomBytes(32).toString('hex')
  const legacySaved = different && fs.exists(legacy) ? JSON.parse(fs.read(legacy)) as TokenFile : null
  if (legacySaved?.token && legacySaved.token !== token) throw new Error('旧源凭据与加密目标不一致，未清理；请恢复原迁移文件后重试')
  const cleanup = saved.pendingCleanup ?? (legacySaved?.token === token ? resolve(legacy) : undefined)
  if (cleanup && resolve(cleanup) !== resolve(legacy)) throw new Error('旧凭据清理位置无效')
  if (!saved.encrypted || source !== target || (cleanup && !saved.pendingCleanup)) {
    const encrypted = protect(token)
    if (reveal(encrypted) !== token) throw new Error('加密凭据核验失败，未修改源文件；请重试')
    fs.atomic(target, { encrypted, ...(cleanup ? { pendingCleanup: cleanup } : {}) })
  }
  const written = JSON.parse(fs.read(target)) as TokenFile
  if (!written.encrypted || written.token !== undefined || reveal(written.encrypted) !== token) throw new Error('加密凭据核验失败，未清理旧文件；请重试')
  if (cleanup) {
    try {
      if (fs.exists(cleanup)) {
        const old = JSON.parse(fs.read(cleanup)) as TokenFile
        if (old.token !== token) throw new Error('source changed')
        fs.remove(cleanup)
      }
      fs.atomic(target, { encrypted: written.encrypted })
    } catch { throw new Error('旧明文凭据清理未完成，服务未启动；请恢复目录写权限后重试') }
  }
  return token
}
