/**
 * 文件读状态跟踪：防止 `write` 基于陈旧读取整体覆盖文件。
 *
 * Pi SDK 的 `write` 是全量覆盖（"Creates the file if it doesn't exist, overwrites if it does"），
 * 执行前不做任何「是否读过」校验。场景：模型读过文件 → 用户在编辑器里改了 → 模型基于旧理解
 * 整体重写 → 用户改动静默丢失。
 *
 * 本模块照 Claude Code 的口径实现，只回答一个问题：**你读到的内容还是不是现在的**。
 *
 * 刻意不做的两件事：
 * - 不看 git 状态。工作区脏不等于有冲突，脏 WIP 本来就该能正常编辑。
 * - 不只比 mtime。编辑器「打开再保存」会刷新 mtime 但内容未变，只比时间会误报；
 *   所以 mtime/size 变化后才退化为内容比对。
 *
 * 边界：只覆盖 Profer 包装的 `write` 工具。`edit` 用 oldText 精确匹配，文件变过就匹配不上，
 * 本身是安全的，不需要这层保护。
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

/** 超过这个大小不做内容 hash：read 本身只读前若干行，再读全文成本不成比例。 */
const MAX_HASH_BYTES = 2 * 1024 * 1024

/** 单会话最多跟踪多少文件，超出按最久未访问淘汰，防止长跑进程内存膨胀。 */
const MAX_TRACKED_FILES_PER_SESSION = 500

export interface FileReadRecord {
  /** 读取时的 mtime（毫秒） */
  mtimeMs: number
  /** 读取时的文件大小 */
  size: number
  /** 完整内容指纹；文件过大时为 undefined（此时只能靠 mtime/size 判断） */
  hash?: string
  /** 是否完整读取（read 没有发生 truncation） */
  complete: boolean
  /** 最近一次读取时间，用于 LRU */
  at: number
}

export type WriteCheckFailureKind = 'not_read' | 'partial_read' | 'changed'

export type WriteCheckResult =
  | { ok: true }
  | { ok: false; kind: WriteCheckFailureKind; message: string }

/**
 * 规范化用于指纹计算的文本。
 *
 * 去 BOM、CRLF 统一为 LF —— 否则 Windows 编辑器自动换行符转换会造成持续误报。
 */
export function normalizeForFingerprint(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replaceAll('\r\n', '\n')
}

export function fingerprintContent(text: string): string {
  return createHash('sha256').update(normalizeForFingerprint(text), 'utf8').digest('hex')
}

/** 读取文件当前状态；文件不存在返回 null。 */
export async function readFileState(absPath: string): Promise<{ mtimeMs: number; size: number; hash?: string } | null> {
  let st
  try {
    st = await stat(absPath)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  let hash: string | undefined
  if (st.size <= MAX_HASH_BYTES) {
    try {
      hash = fingerprintContent(await readFile(absPath, 'utf-8'))
    } catch {
      hash = undefined
    }
  }
  return { mtimeMs: Math.floor(st.mtimeMs), size: st.size, hash }
}

export class FileReadTracker {
  private readonly sessions = new Map<string, Map<string, FileReadRecord>>()

  /** 记录一次读取。`complete=false` 表示 read 被截断，后续不允许直接覆盖。 */
  record(sessionId: string, absPath: string, info: { mtimeMs: number; size: number; hash?: string; complete: boolean }): void {
    let files = this.sessions.get(sessionId)
    if (!files) {
      files = new Map()
      this.sessions.set(sessionId, files)
    }
    files.delete(absPath)
    files.set(absPath, { ...info, mtimeMs: Math.floor(info.mtimeMs), at: Date.now() })
    if (files.size > MAX_TRACKED_FILES_PER_SESSION) {
      const oldest = files.keys().next()
      if (!oldest.done) files.delete(oldest.value)
    }
  }

  /**
   * 写覆盖前的校验。
   *
   * @param current 目标文件当前状态；文件不存在传 null（表示新建，直接放行）
   */
  check(sessionId: string, absPath: string, current: { mtimeMs: number; size: number; hash?: string } | null): WriteCheckResult {
    if (current === null) return { ok: true }

    const record = this.sessions.get(sessionId)?.get(absPath)
    if (!record) {
      return {
        ok: false,
        kind: 'not_read',
        message: `文件 ${absPath} 尚未在本会话中读取过。整文件写入会覆盖磁盘上的现有内容，请先用 read 工具读取当前内容，确认后再写入。`,
      }
    }

    if (!record.complete) {
      return {
        ok: false,
        kind: 'partial_read',
        message: `文件 ${absPath} 只被读取了部分内容（上次读取被截断）。基于片段重写整个文件会丢失未读部分，请完整读取后再写入。`,
      }
    }

    const unchanged = record.mtimeMs === current.mtimeMs && record.size === current.size
    if (unchanged) {
      // 顺带刷新 LRU 顺序
      this.touch(sessionId, absPath)
      return { ok: true }
    }

    // mtime/size 变了：可能是内容真的改了，也可能只是「打开再保存」。
    // 双方都有指纹时才能判定未变；任一方缺指纹时保守拒绝。
    if (record.hash !== undefined && current.hash !== undefined && record.hash === current.hash) {
      this.touch(sessionId, absPath)
      return { ok: true }
    }

    return {
      ok: false,
      kind: 'changed',
      message: `文件 ${absPath} 在本会话读取之后已被修改。整文件写入会覆盖这些改动，请重新读取当前内容后再写入。`,
    }
  }

  /** 会话结束后清理，避免长期运行的进程里累积。 */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 仅用于测试与观测。 */
  snapshot(sessionId: string): Record<string, FileReadRecord> {
    return Object.fromEntries(this.sessions.get(sessionId) ?? [])
  }

  private touch(sessionId: string, absPath: string): void {
    const files = this.sessions.get(sessionId)
    const record = files?.get(absPath)
    if (!files || !record) return
    files.delete(absPath)
    record.at = Date.now()
    files.set(absPath, record)
  }
}

/** 判断 read 工具的输出是否被截断（Pi 的两种截断提示）。 */
export function isTruncatedReadOutput(text: string): boolean {
  return /\[Showing lines \d+-\d+ of \d+/.test(text) || /\[\d+ more lines in file\. Use offset=/.test(text)
}
