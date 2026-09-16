/**
 * 历史会话存储「整理」（compaction）——把已落盘的过大工具输出/内嵌图片换成预览。
 *
 * 背景：落盘截断逻辑此前有 4 个覆盖缺口（顶层 `tool_use_result` 未处理、扁平 `data`
 * 图片漏过、数组内 text 无分支、阈值按原文长度而非序列化长度判断），导致真机上积累
 * 了超限行（实测 1107 文件中 167 条，合计 169 MB）。补洞只保证「此后不再产生」，
 * 已经在磁盘上的必须另行整理一次——否则打开这类会话时仍要把整条巨型行读进内存。
 *
 * 与截断逻辑的关系：本模块**不自己实现截断**，而是调用
 * `agent-session-manager.sanitizeSerializedSessionLine`。写入路径与整理路径共用同一个
 * 入口，规则只会有一份；4 个缺口那次的教训正是「同一套规则散在多处、各自漏一处」。
 *
 * 为什么全部用异步 fs：整理由用户在设置页触发，真机全量约 4~16 秒。用同步 fs 会把
 * 主进程（进而整个 UI）卡住；异步 fs 在 I/O 之间让出事件循环，界面仍可响应。
 * 这与既有的 `calculateStorageStats` 保持同一取舍。
 *
 * 安全约束：
 * 1. 只改超限行，其余行逐字节原样保留（按 `\n` 切分再拼回，不动换行风格）。
 * 2. 改写前整份备份到 `<configDir>/migrations/backup-<时间戳>/`。
 * 3. 先写 `<file>.compact-tmp`，成功后 `rename` 原子替换——中途中断不会留下半个文件。
 * 4. 读取后、替换前各测一次文件大小：期间被追加（app 正在写该会话）就放弃这个文件，
 *    避免把并发追加的内容吞掉。
 * 5. 单个文件出错只记录并继续，不中断整轮。
 *
 * 闸门：用**内容自闸**（扫到超限行才动手）而不是版本标记文件。标记会失配——用户从
 * 备份恢复旧文件后标记仍在，就永远不会再整理。自闸不存在这种漏网，代价只是一次扫描。
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentSessionsDir, getConfigDir } from './config-paths'
import { MAX_SDK_MESSAGE_LENGTH, sanitizeSerializedSessionLine } from './agent-session-manager'

export interface SessionCompactionResult {
  /** 扫描的会话文件数 */
  scannedFiles: number
  /** 实际被改写的文件数 */
  rewrittenFiles: number
  /** 被改写的行数 */
  rewrittenLines: number
  /** 因期间被并发追加而跳过的文件数 */
  skippedFiles: number
  /** 处理失败的文件数（错误见 errors） */
  failedFiles: number
  /** 被改写行的整理前字符数 */
  charsBefore: number
  /** 被改写行的整理后字符数 */
  charsAfter: number
  /** 备份目录（本次无改写时为 undefined） */
  backupDir?: string
  /** 逐文件错误信息（最多保留 20 条，避免异常时刷屏） */
  errors: string[]
}

const TMP_SUFFIX = '.compact-tmp'
const MAX_RECORDED_ERRORS = 20

function createEmptyResult(): SessionCompactionResult {
  return {
    scannedFiles: 0,
    rewrittenFiles: 0,
    rewrittenLines: 0,
    skippedFiles: 0,
    failedFiles: 0,
    charsBefore: 0,
    charsAfter: 0,
    errors: [],
  }
}

async function listSessionFiles(sessionsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsDir)
    return entries.filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
}

async function ensureBackupDir(result: SessionCompactionResult): Promise<string> {
  if (result.backupDir) return result.backupDir
  const dir = join(getConfigDir(), 'migrations', `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(dir, { recursive: true })
  result.backupDir = dir
  return dir
}

function recordError(result: SessionCompactionResult, name: string, error: unknown): void {
  result.failedFiles++
  if (result.errors.length < MAX_RECORDED_ERRORS) {
    result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 仅统计不写入：用于先给用户看「整理能省多少」再决定是否执行。
 */
export async function previewAgentSessionCompaction(): Promise<SessionCompactionResult> {
  const result = createEmptyResult()
  const sessionsDir = getAgentSessionsDir()

  for (const name of await listSessionFiles(sessionsDir)) {
    result.scannedFiles++
    try {
      const filePath = join(sessionsDir, name)
      if ((await stat(filePath)).size <= MAX_SDK_MESSAGE_LENGTH) continue

      const lines = (await readFile(filePath, 'utf-8')).split('\n')
      let touched = false
      for (const line of lines) {
        if (line.length <= MAX_SDK_MESSAGE_LENGTH) continue
        const compacted = sanitizeSerializedSessionLine(line, name)
        if (compacted === line) continue
        touched = true
        result.rewrittenLines++
        result.charsBefore += line.length
        result.charsAfter += compacted.length
      }
      if (touched) result.rewrittenFiles++
    } catch (error) {
      recordError(result, name, error)
    }
  }

  return result
}

/**
 * 就地整理所有会话文件里的超限行。幂等：没有超限行时不做任何写入。
 */
export async function compactAgentSessionStorage(): Promise<SessionCompactionResult> {
  const result = createEmptyResult()
  const sessionsDir = getAgentSessionsDir()

  for (const name of await listSessionFiles(sessionsDir)) {
    const filePath = join(sessionsDir, name)
    result.scannedFiles++

    try {
      // UTF-8 下字节数 ≥ 字符数，所以文件总字节数不超过上限时，不可能存在超限行。
      // 这一步让绝大多数小文件免于读取。
      const sizeBeforeRead = (await stat(filePath)).size
      if (sizeBeforeRead <= MAX_SDK_MESSAGE_LENGTH) continue

      const lines = (await readFile(filePath, 'utf-8')).split('\n')
      let fileChanged = false
      let fileCharsBefore = 0
      let fileCharsAfter = 0
      let fileLinesRewritten = 0

      const compactedLines = lines.map((line) => {
        if (line.length <= MAX_SDK_MESSAGE_LENGTH) return line
        const compacted = sanitizeSerializedSessionLine(line, name)
        if (compacted === line) return line
        fileChanged = true
        fileLinesRewritten++
        fileCharsBefore += line.length
        fileCharsAfter += compacted.length
        return compacted
      })

      if (!fileChanged) continue

      // 并发保护：读取期间文件被追加说明 app 正在写这个会话，本轮放过它。
      if ((await stat(filePath)).size !== sizeBeforeRead) {
        result.skippedFiles++
        continue
      }

      const backupDir = await ensureBackupDir(result)
      await copyFile(filePath, join(backupDir, name))

      const tmpPath = filePath + TMP_SUFFIX
      await writeFile(tmpPath, compactedLines.join('\n'), 'utf-8')
      await rename(tmpPath, filePath)

      result.rewrittenFiles++
      result.rewrittenLines += fileLinesRewritten
      result.charsBefore += fileCharsBefore
      result.charsAfter += fileCharsAfter
    } catch (error) {
      recordError(result, name, error)
      // 失败时清掉可能残留的临时文件，避免污染会话目录
      try {
        await rm(filePath + TMP_SUFFIX, { force: true })
      } catch {
        // 清理失败不覆盖原始错误
      }
    }
  }

  return result
}
