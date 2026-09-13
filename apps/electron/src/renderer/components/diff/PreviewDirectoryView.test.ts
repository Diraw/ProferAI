import { describe, expect, test } from 'bun:test'
import { formatEntrySize } from './PreviewDirectoryView'

describe('formatEntrySize（目录视图体积列）', () => {
  test('小于 1KB 用字节', () => {
    expect(formatEntrySize(0)).toBe('0 B')
    expect(formatEntrySize(1023)).toBe('1023 B')
  })

  test('KB/MB 取值：小于 10 保留一位小数，否则取整', () => {
    expect(formatEntrySize(1024)).toBe('1.0 KB')
    expect(formatEntrySize(1536)).toBe('1.5 KB')
    expect(formatEntrySize(10 * 1024)).toBe('10 KB')
    expect(formatEntrySize(2.4 * 1024 * 1024)).toBe('2.4 MB')
  })

  test('目录没有 size，非法值不显示', () => {
    expect(formatEntrySize(undefined)).toBe('')
    expect(formatEntrySize(-1)).toBe('')
    expect(formatEntrySize(Number.NaN)).toBe('')
  })
})
