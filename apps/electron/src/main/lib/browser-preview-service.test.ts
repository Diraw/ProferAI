import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthorizedPreviewUrl } from './browser-preview-service'

/** 建立一个临时项目：root/（授权根）与 outside/（授权根之外）。路径统一 realpath，避免 macOS /var → /private/var 差异 */
function createFixture(): { root: string; outside: string } {
  // realpath 后拿到稳定路径：实现内部处处 realpathSync
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'profer-browser-preview-')))
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<html></html>')
  writeFileSync(join(outside, 'report.html'), '<html></html>')
  writeFileSync(join(outside, 'notes.txt'), 'text')
  return { root, outside }
}

describe('createAuthorizedPreviewUrl', () => {
  test('授权根内的 HTML 走短期 profer-file 目录 URL', () => {
    const { root } = createFixture()
    const result = createAuthorizedPreviewUrl(join(root, 'index.html'), [root])
    expect(result.url.startsWith('profer-file://')).toBe(true)
    expect(result.filePath).toBe(join(root, 'index.html'))
  })

  test('目录入参优先解析 index.html', () => {
    const { root } = createFixture()
    const result = createAuthorizedPreviewUrl(root, [root])
    expect(result.filePath).toBe(join(root, 'index.html'))
  })

  test('授权根之外的本地 HTML 也放行（只读预览边界）', () => {
    const { root, outside } = createFixture()
    const result = createAuthorizedPreviewUrl(join(outside, 'report.html'), [root])
    expect(result.url.startsWith('profer-file://')).toBe(true)
    expect(result.filePath).toBe(join(outside, 'report.html'))
  })

  test('非 HTML 文件仍然拒绝', () => {
    const { root, outside } = createFixture()
    expect(() => createAuthorizedPreviewUrl(join(outside, 'notes.txt'), [root])).toThrow(/只支持 HTML/)
  })

  test('目录缺少 index.html 时拒绝', () => {
    const { root, outside } = createFixture()
    expect(() => createAuthorizedPreviewUrl(outside, [root])).toThrow(/index\.html/)
  })

  test('授权根列表混入不存在或非目录的根不会让预览整体失败', () => {
    const { root, outside } = createFixture()
    const brokenRoots = [join(root, 'missing-dir'), join(outside, 'notes.txt')]
    const result = createAuthorizedPreviewUrl(join(root, 'index.html'), [...brokenRoots, root])
    expect(result.filePath).toBe(join(root, 'index.html'))
  })

  test('空路径拒绝', () => {
    const { root } = createFixture()
    expect(() => createAuthorizedPreviewUrl('   ', [root])).toThrow(/不能为空/)
  })
})
