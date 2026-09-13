import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// skin-service 经 config-paths 间接导入 Electron；单测只需最小主进程 mock。
mock.module('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  net: {},
}))

// 隔离配置根目录：预览读取必须落在临时目录，不能读写真实 ~/.profer-dev/skins。
const configRoot = mkdtempSync(join(tmpdir(), 'profer-skin-preview-config-'))
process.env.PROFER_CONFIG_DIR = configRoot

const { getSkinPreview } = await import('./skin-service')

const SKIN_ID = 'preview-cache-skin'

/** 创建（或复用）皮肤目录；皮肤目录结构是对用户公开的文档。 */
function skinDir(): string {
  const dir = join(configRoot, 'skins', SKIN_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: SKIN_ID, name: 'Preview cache skin', tone: 'dark' }),
    'utf8',
  )
  return dir
}

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

describe('皮肤预览缓存按文件签名失效', () => {
  test('Given 首次查询无预览 When 之后补上 preview.png Then 无需重启或增删皮肤即可读到', () => {
    const dir = skinDir()
    // 第一次查询：无预览文件，结果会被缓存
    expect(getSkinPreview(SKIN_ID)).toBeNull()

    // 用户按公开文档往皮肤目录补一张预览图
    writeFileSync(join(dir, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    // 旧实现命中空的缓存条目后会永久返回 null，必须重启应用或触发皮肤增删才能看到
    expect(getSkinPreview(SKIN_ID)).toStartWith('data:image/png;base64,')
  })

  test('Given 同名预览文件被替换 When 再次读取 Then 返回新内容', () => {
    const dir = skinDir()
    writeFileSync(join(dir, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const first = getSkinPreview(SKIN_ID)

    writeFileSync(join(dir, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const second = getSkinPreview(SKIN_ID)

    expect(first).toStartWith('data:image/png;base64,')
    expect(second).toStartWith('data:image/png;base64,')
    expect(second).not.toBe(first)
  })
})
