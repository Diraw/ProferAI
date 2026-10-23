/**
 * 流式 ZIP 读取器（无第三方依赖）。
 *
 * 与 zip-stream-writer 对称：导入 GB 级备份时不能把整个压缩包读进内存。
 * 这里只把「中心目录」读进内存（几 MB 量级），条目内容按偏移逐条流式解压。
 *
 * 安全边界由调用方负责（迁移服务的 assertSafeMigrationArchiveEntries），
 * 本模块额外做一次目标目录约束，避免被误用于未校验的条目名。
 */

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50
const CENTRAL_DIR_HEADER_SIG = 0x02014b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

const EOCD_MIN_SIZE = 22
const MAX_COMMENT_SIZE = 0xffff

export interface ZipEntryMeta {
  name: string
  isDirectory: boolean
  method: number
  flags: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export interface ZipExtractOptions {
  /** 校验失败的条目以警告形式回报，不中断其余条目的恢复 */
  onWarning?: (message: string) => void
  onProgress?: (bytesWritten: number) => void
}

export interface ZipExtractResult {
  files: number
  bytes: number
  warnings: string[]
}

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  crcTable = table
  return table
}

function crc32Update(crc: number, chunk: Buffer): number {
  const table = getCrcTable()
  let value = crc ^ -1
  for (let i = 0; i < chunk.length; i++) {
    value = table[(value ^ chunk[i]!) & 0xff]! ^ (value >>> 8)
  }
  return (value ^ -1) >>> 0
}

/** 读取并解析 ZIP 中心目录。损坏的归档给出明确错误，不返回半截条目。 */
export async function readZipEntries(filePath: string): Promise<ZipEntryMeta[]> {
  const handle = await fsp.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size < EOCD_MIN_SIZE) throw new Error('无效的迁移文件：文件过短')

    const tailSize = Math.min(stat.size, EOCD_MIN_SIZE + MAX_COMMENT_SIZE)
    const tailStart = stat.size - tailSize
    const tail = Buffer.alloc(tailSize)
    await handle.read(tail, 0, tailSize, tailStart)

    let eocdOffsetInTail = -1
    for (let i = tailSize - EOCD_MIN_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD_SIG) continue
      const commentLength = tail.readUInt16LE(i + 20)
      if (i + EOCD_MIN_SIZE + commentLength !== tailSize) continue
      eocdOffsetInTail = i
      break
    }
    if (eocdOffsetInTail < 0) throw new Error('无效的迁移文件：找不到 ZIP 目录结尾')

    const eocdOffset = tailStart + eocdOffsetInTail
    let entries = tail.readUInt16LE(eocdOffsetInTail + 10)
    let centralDirSize = tail.readUInt32LE(eocdOffsetInTail + 12)
    let centralDirOffset = tail.readUInt32LE(eocdOffsetInTail + 16)

    const needsZip64 = entries === U16_MAX
      || centralDirSize === U32_MAX
      || centralDirOffset === U32_MAX

    if (needsZip64) {
      const locatorOffset = eocdOffset - 20
      if (locatorOffset < 0) throw new Error('无效的迁移文件：缺少 zip64 定位记录')
      const locator = Buffer.alloc(20)
      await handle.read(locator, 0, 20, locatorOffset)
      if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR_SIG) {
        throw new Error('无效的迁移文件：zip64 定位记录损坏')
      }
      const zip64EocdOffset = Number(locator.readBigUInt64LE(8))
      const record = Buffer.alloc(56)
      await handle.read(record, 0, 56, zip64EocdOffset)
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
        throw new Error('无效的迁移文件：zip64 目录结尾损坏')
      }
      entries = Number(record.readBigUInt64LE(32))
      centralDirSize = Number(record.readBigUInt64LE(40))
      centralDirOffset = Number(record.readBigUInt64LE(48))
    }

    if (centralDirSize === 0) return []
    const centralDir = Buffer.alloc(centralDirSize)
    const read = await handle.read(centralDir, 0, centralDirSize, centralDirOffset)
    if (read.bytesRead !== centralDirSize) throw new Error('无效的迁移文件：目录区读取不完整')

    const parsed: ZipEntryMeta[] = []
    let cursor = 0
    for (let index = 0; index < entries; index++) {
      if (cursor + 46 > centralDir.length) throw new Error('无效的迁移文件：目录条目越界')
      if (centralDir.readUInt32LE(cursor) !== CENTRAL_DIR_HEADER_SIG) {
        throw new Error('无效的迁移文件：目录条目签名错误')
      }
      const flags = centralDir.readUInt16LE(cursor + 8)
      const method = centralDir.readUInt16LE(cursor + 10)
      const crc = centralDir.readUInt32LE(cursor + 16)
      let compressedSize = centralDir.readUInt32LE(cursor + 20)
      let uncompressedSize = centralDir.readUInt32LE(cursor + 24)
      const nameLength = centralDir.readUInt16LE(cursor + 28)
      const extraLength = centralDir.readUInt16LE(cursor + 30)
      const commentLength = centralDir.readUInt16LE(cursor + 32)
      let localHeaderOffset = centralDir.readUInt32LE(cursor + 42)

      const nameStart = cursor + 46
      const nameBuffer = centralDir.subarray(nameStart, nameStart + nameLength)
      // 我们自己写出的归档一律 UTF-8；外部归档没有该标志时按 latin1 兜底，
      // 避免把合法文件名解成替换字符导致路径校验误判。
      const name = (flags & 0x0800) !== 0
        ? nameBuffer.toString('utf8')
        : nameBuffer.toString('latin1')

      const extraStart = nameStart + nameLength
      const extra = centralDir.subarray(extraStart, extraStart + extraLength)
      let extraCursor = 0
      while (extraCursor + 4 <= extra.length) {
        const fieldId = extra.readUInt16LE(extraCursor)
        const fieldSize = extra.readUInt16LE(extraCursor + 2)
        const bodyStart = extraCursor + 4
        if (bodyStart + fieldSize > extra.length) break
        if (fieldId === ZIP64_EXTRA_FIELD_ID) {
          let bodyCursor = bodyStart
          if (uncompressedSize === U32_MAX && bodyCursor + 8 <= bodyStart + fieldSize) {
            uncompressedSize = Number(extra.readBigUInt64LE(bodyCursor))
            bodyCursor += 8
          }
          if (compressedSize === U32_MAX && bodyCursor + 8 <= bodyStart + fieldSize) {
            compressedSize = Number(extra.readBigUInt64LE(bodyCursor))
            bodyCursor += 8
          }
          if (localHeaderOffset === U32_MAX && bodyCursor + 8 <= bodyStart + fieldSize) {
            localHeaderOffset = Number(extra.readBigUInt64LE(bodyCursor))
          }
        }
        extraCursor = bodyStart + fieldSize
      }

      parsed.push({
        name,
        isDirectory: name.endsWith('/'),
        method,
        flags,
        crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      })
      cursor = extraStart + extraLength + commentLength
    }
    return parsed
  } finally {
    await handle.close()
  }
}

/** 计算条目数据区的起始偏移（局部头长度可变）。 */
async function resolveDataOffset(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  entry: ZipEntryMeta,
): Promise<number> {
  const header = Buffer.alloc(30)
  const read = await handle.read(header, 0, 30, entry.localHeaderOffset)
  if (read.bytesRead !== 30) throw new Error(`迁移文件条目损坏: ${entry.name}`)
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`迁移文件条目签名错误: ${entry.name}`)
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  return entry.localHeaderOffset + 30 + nameLength + extraLength
}

/**
 * 按中心目录流式解包到 targetDir。
 *
 * 调用方必须先完成条目名校验；这里仍会再做一次目标目录约束。
 */
export async function extractZipEntries(
  filePath: string,
  entries: readonly ZipEntryMeta[],
  targetDir: string,
  options: ZipExtractOptions = {},
): Promise<ZipExtractResult> {
  const warnings: string[] = []
  const resolvedTarget = resolve(targetDir)
  let files = 0
  let bytes = 0

  const handle = await fsp.open(filePath, 'r')
  try {
    for (const entry of entries) {
      if (entry.isDirectory) continue
      if ((entry.flags & 0x0001) !== 0) {
        throw new Error(`迁移文件包含加密条目，暂不支持: ${entry.name}`)
      }

      const destination = resolve(resolvedTarget, entry.name)
      if (destination !== resolvedTarget && !destination.startsWith(`${resolvedTarget}${sep}`)) {
        throw new Error(`迁移文件包含非法路径，已拒绝解压: ${entry.name}`)
      }

      await fsp.mkdir(dirname(destination), { recursive: true })
      const dataOffset = await resolveDataOffset(handle, entry)

      if (entry.compressedSize === 0) {
        await fsp.writeFile(destination, Buffer.alloc(0))
        files += 1
        continue
      }

      let crc = 0
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          crc = crc32Update(crc, chunk)
          callback(null, chunk)
        },
      })
      const output = createWriteStream(destination)
      const sink = new Writable({
        write: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.length
          options.onProgress?.(bytes)
          if (output.write(chunk)) callback()
          else output.once('drain', callback)
        },
      })

      const source = createReadStream(filePath, {
        start: dataOffset,
        end: dataOffset + entry.compressedSize - 1,
      })

      try {
        if (entry.method === 8) {
          await pipeline(source, createInflateRaw(), counter, sink)
        } else if (entry.method === 0) {
          await pipeline(source, counter, sink)
        } else {
          throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`)
        }
        await new Promise<void>((resolveEnd, rejectEnd) => {
          output.end((error?: Error | null) => (error ? rejectEnd(error) : resolveEnd()))
        })
      } catch (error) {
        output.destroy()
        const message = `解压失败，已跳过: ${entry.name} (${error instanceof Error ? error.message : String(error)})`
        warnings.push(message)
        options.onWarning?.(message)
        continue
      }

      if (crc !== entry.crc) {
        const message = `校验和不匹配，内容可能损坏: ${entry.name}`
        warnings.push(message)
        options.onWarning?.(message)
      }
      files += 1
    }
  } finally {
    await handle.close()
  }

  return { files, bytes, warnings }
}
