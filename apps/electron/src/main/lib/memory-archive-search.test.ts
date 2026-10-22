import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryArchiveSearcher,
  memoryFreshnessNote,
  memoryHitAgeDays,
  type MemoryArchiveSearchHit,
} from './memory-archive-search'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mem-search-'))
  dirs.push(dir)
  return dir
}

/** 把文件 mtime 推到 N 天前，模拟陈旧记忆。 */
function ageFile(path: string, days: number): void {
  const t = new Date(Date.now() - days * 86_400_000)
  utimesSync(path, t, t)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('memoryHitAgeDays', () => {
  test('当天写入的记忆算 0 天', () => {
    const dir = makeDir()
    const file = join(dir, 'fresh.md')
    writeFileSync(file, 'We decided to use SQLite for the memory index.')
    const searcher = createMemoryArchiveSearcher(dir)
    const hits = searcher.search('SQLite')
    expect(hits.length).toBe(1)
    expect(memoryHitAgeDays(hits[0]!)).toBe(0)
    searcher.close()
  })

  test('三天前的记忆算 3 天', () => {
    const dir = makeDir()
    const file = join(dir, 'stale.md')
    writeFileSync(file, 'We decided to use SQLite for the memory index.')
    ageFile(file, 3)
    const searcher = createMemoryArchiveSearcher(dir)
    const hits = searcher.search('SQLite')
    expect(hits.length).toBe(1)
    expect(memoryHitAgeDays(hits[0]!)).toBe(3)
    searcher.close()
  })

  test('mtime 缺失时返回 undefined，不误报为 0 天', () => {
    const hit: MemoryArchiveSearchHit = {
      relativePath: 'x.md',
      content: 'x',
      startIndex: 0,
      endIndex: 1,
      score: 0,
      matchedTokens: [],
    }
    expect(memoryHitAgeDays(hit)).toBeUndefined()
  })
})

describe('memoryFreshnessNote', () => {
  test('新鲜命中不产生提示', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'fresh.md'), 'We decided to use SQLite for the memory index.')
    const searcher = createMemoryArchiveSearcher(dir)
    const hits = searcher.search('SQLite')
    expect(memoryFreshnessNote(hits)).toBeUndefined()
    searcher.close()
  })

  test('陈旧命中给出带最大天数的提示', () => {
    const dir = makeDir()
    const oldFile = join(dir, 'old.md')
    writeFileSync(oldFile, 'We decided to use SQLite for the memory index.')
    ageFile(oldFile, 5)
    const freshFile = join(dir, 'fresh.md')
    writeFileSync(freshFile, 'SQLite is also mentioned here today.')
    const searcher = createMemoryArchiveSearcher(dir)
    const hits = searcher.search('SQLite')
    expect(hits.length).toBe(2)
    const note = memoryFreshnessNote(hits)
    expect(note).toContain('5 天前')
    expect(note).toContain('对照当前代码验证')
    searcher.close()
  })

  test('空命中与无 mtime 命中都不产生提示', () => {
    expect(memoryFreshnessNote([])).toBeUndefined()
    expect(
      memoryFreshnessNote([
        {
          relativePath: 'x.md',
          content: 'x',
          startIndex: 0,
          endIndex: 1,
          score: 0,
          matchedTokens: [],
        },
      ]),
    ).toBeUndefined()
  })

  test('提示文案不随命中条数线性膨胀（固定一行）', () => {
    const dir = makeDir()
    for (let i = 0; i < 5; i += 1) {
      const file = join(dir, `m${i}.md`)
      writeFileSync(file, `SQLite note number ${i}.`)
      ageFile(file, 2 + i)
    }
    const searcher = createMemoryArchiveSearcher(dir)
    const hits = searcher.search('SQLite', 5)
    const note = memoryFreshnessNote(hits)
    expect(note).toContain('6 天前')
    expect(note!.split('\n').length).toBe(1)
    searcher.close()
  })
})
