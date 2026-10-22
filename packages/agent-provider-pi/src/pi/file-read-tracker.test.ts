import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileReadTracker,
  fingerprintContent,
  isTruncatedReadOutput,
  normalizeForFingerprint,
  readFileState,
} from './file-read-tracker'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'read-tracker-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 读一次并登记，模拟 read 工具执行后的跟踪。 */
async function recordFile(tracker: FileReadTracker, sessionId: string, path: string, complete = true) {
  const info = await readFileState(path)
  if (!info) throw new Error(`fixture missing: ${path}`)
  tracker.record(sessionId, path, { ...info, complete })
  return info
}

describe('规范化与指纹', () => {
  test('CRLF 与 LF 得到相同指纹（避免编辑器换行符转换误报）', () => {
    expect(fingerprintContent('a\r\nb')).toBe(fingerprintContent('a\nb'))
  })

  test('BOM 不影响指纹', () => {
    expect(fingerprintContent('\uFEFFhello')).toBe(fingerprintContent('hello'))
  })

  test('内容真的变了指纹就不同', () => {
    expect(fingerprintContent('a\nb')).not.toBe(fingerprintContent('a\nc'))
  })

  test('normalizeForFingerprint 只做 BOM 与行尾处理', () => {
    expect(normalizeForFingerprint('\uFEFFx\r\ny')).toBe('x\ny')
  })
})

describe('FileReadTracker.check', () => {
  test('没读过就拒绝整文件覆盖', () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v1')
    const result = tracker.check('s1', file, { mtimeMs: 1, size: 2, hash: fingerprintContent('v1') })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('not_read')
      expect(result.message).toContain('尚未在本会话中读取')
    }
  })

  test('目标文件不存在时放行（新建文件）', () => {
    const tracker = new FileReadTracker()
    expect(tracker.check('s1', '/tmp/does-not-exist.txt', null).ok).toBe(true)
  })

  test('读过且未变化时放行', async () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v1')
    const info = await recordFile(tracker, 's1', file)
    expect(tracker.check('s1', file, info).ok).toBe(true)
  })

  test('读后被改动且内容不同则拒绝', async () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v1')
    const before = await recordFile(tracker, 's1', file)

    writeFileSync(file, 'v2-changed')
    const after = await readFileState(file)
    const result = tracker.check('s1', file, after)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('changed')
    // 与读取时的状态确实不同
    expect(after!.size).not.toBe(before.size)
  })

  test('mtime 变了但内容等价时放行（touch / 编辑器重存）', async () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'same-content')
    await recordFile(tracker, 's1', file)

    // 模拟「打开再保存」：内容不变，mtime/size 由调用方伪造为不同值
    const sameHash = fingerprintContent('same-content')
    const result = tracker.check('s1', file, { mtimeMs: Number.MAX_SAFE_INTEGER, size: 999_999, hash: sameHash })
    expect(result.ok).toBe(true)
  })

  test('只读了部分内容时拒绝覆盖', async () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'lots of content')
    const info = await recordFile(tracker, 's1', file, false)
    const result = tracker.check('s1', file, info)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('partial_read')
  })

  test('任一方缺指纹且 mtime 变化时保守拒绝', async () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v1')
    // 记录时不带 hash（模拟超大文件）
    const info = await readFileState(file)
    tracker.record('s1', file, { mtimeMs: info!.mtimeMs, size: info!.size, complete: true })
    const result = tracker.check('s1', file, { mtimeMs: info!.mtimeMs + 1, size: info!.size + 1 })
    expect(result.ok).toBe(false)
  })

  test('不同会话互不影响', async () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v1')
    const info = await recordFile(tracker, 'session-a', file)
    expect(tracker.check('session-b', file, info).ok).toBe(false)
    expect(tracker.check('session-a', file, info).ok).toBe(true)
  })

  test('forget 之后回到未读状态', async () => {
    const tracker = new FileReadTracker()
    const dir = makeDir()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'v1')
    const info = await recordFile(tracker, 's1', file)
    tracker.forget('s1')
    expect(tracker.check('s1', file, info).ok).toBe(false)
  })
})

describe('isTruncatedReadOutput', () => {
  test('识别行数截断提示', () => {
    expect(isTruncatedReadOutput('[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]')).toBe(true)
  })

  test('识别用户 limit 截断提示', () => {
    expect(isTruncatedReadOutput('[300 more lines in file. Use offset=101 to continue.]')).toBe(true)
  })

  test('正常完整内容不误判', () => {
    expect(isTruncatedReadOutput('const a = 1\nconst b = 2')).toBe(false)
  })
})
