import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

mock.module('electron', () => ({
  app: { getVersion: () => '0.15.80' },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' },
}))

const {
  cleanupStalePluginTempDirs,
  installPluginPackage,
  listInstalledPlugins,
  parsePluginManifest,
  removePlugin,
  resolvePluginDataFile,
  setPluginEnabled,
} = await import('./plugin-manager')

let root = ''

function createPlugin(overrides: Record<string, unknown> = {}): string {
  const directory = join(root, 'source')
  mkdirSync(join(directory, 'dist'), { recursive: true })
  writeFileSync(join(directory, 'dist', 'index.html'), '<!doctype html><title>Demo</title>', 'utf8')
  writeFileSync(join(directory, 'profer-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'com.example.demo',
    name: 'Demo Plugin',
    version: '1.0.0',
    permissions: ['pluginStorage'],
    contributes: { pages: [{ id: 'dashboard', title: 'Demo', entry: 'dist/index.html' }] },
    ...overrides,
  }), 'utf8')
  return directory
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-plugin-manager-'))
  process.env.PROFER_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('插件 manifest 校验', () => {
  test('接受页面贡献与已知权限', () => {
    const manifest = parsePluginManifest({
      schemaVersion: 1,
      id: 'com.example.router',
      name: '峰谷模型路由',
      version: '1.0.0',
      permissions: ['pluginStorage', 'models.read'],
      contributes: {
        pages: [{ id: 'settings', title: '路由设置', entry: 'dist/index.html', placements: ['settings', 'tab'] }],
        modelRoutingPolicies: [{ id: 'time-routing', kind: 'model-routing.rules.v1' }],
      },
    })
    expect(manifest.id).toBe('com.example.router')
    expect(manifest.contributes.pages?.[0]?.entry).toBe('dist/index.html')
  })

  test('拒绝目录穿越页面入口', () => {
    expect(() => parsePluginManifest({
      schemaVersion: 1,
      id: 'com.example.bad',
      name: 'Bad',
      version: '1.0.0',
      contributes: { pages: [{ id: 'main', title: 'Bad', entry: '../secret.html' }] },
    })).toThrow('必须位于插件目录内')
  })

  test('拒绝不兼容的 Profer 版本范围', () => {
    expect(() => parsePluginManifest({
      schemaVersion: 1,
      id: 'com.example.future',
      name: 'Future',
      version: '1.0.0',
      engines: { profer: '>=99.0.0' },
      contributes: { pages: [{ id: 'main', title: 'Main', entry: 'dist/index.html' }] },
    })).toThrow('插件不支持当前 Profer 版本')
  })

  test('拒绝未知权限和没有贡献的空插件', () => {
    expect(() => parsePluginManifest({
      schemaVersion: 1,
      id: 'com.example.bad',
      name: 'Bad',
      version: '1.0.0',
      permissions: ['filesystem.full'],
      contributes: {},
    })).toThrow('不支持的权限')
    expect(() => parsePluginManifest({
      schemaVersion: 1,
      id: 'com.example.empty',
      name: 'Empty',
      version: '1.0.0',
      contributes: {},
    })).toThrow('至少需要贡献')
  })
})

describe('插件目录安装与生命周期', () => {
  test('安装后默认启用，并可停用、启用和卸载且保留数据', () => {
    const source = createPlugin()
    const installed = installPluginPackage(source)
    expect(installed).toMatchObject({ ok: true, status: 'installed' })
    expect(listInstalledPlugins()).toHaveLength(1)
    expect(listInstalledPlugins()[0]).toMatchObject({ enabled: true, manifest: { id: 'com.example.demo' } })
    expect(installPluginPackage(source).status).toBe('conflict')
    expect(installPluginPackage(source, true).status).toBe('updated')

    expect(setPluginEnabled('com.example.demo', false)).toMatchObject({ ok: true, status: 'disabled' })
    expect(listInstalledPlugins()[0]?.enabled).toBe(false)
    expect(setPluginEnabled('com.example.demo', true)).toMatchObject({ ok: true, status: 'enabled' })

    const dataFile = resolvePluginDataFile('com.example.demo')
    writeFileSync(dataFile, '{"choice":"peak"}', 'utf8')
    expect(removePlugin('com.example.demo')).toMatchObject({ ok: true, status: 'removed' })
    expect(listInstalledPlugins()).toHaveLength(0)
    expect(existsSync(dataFile)).toBe(true)
    expect(readFileSync(dataFile, 'utf8')).toContain('peak')
  })

  test('入口文件缺失时拒绝安装且不污染插件目录', () => {
    const source = createPlugin({
      contributes: { pages: [{ id: 'main', title: 'Missing', entry: 'dist/missing.html' }] },
    })
    const result = installPluginPackage(source)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('页面入口不存在')
    expect(listInstalledPlugins()).toHaveLength(0)
  })

  test('ZIP 路径穿越和本地目录符号链接被拒绝', () => {
    const traversalZipPath = join(root, 'traversal.zip')
    const traversalZip = new AdmZip()
    traversalZip.addFile('../outside.txt', Buffer.from('blocked'))
    traversalZip.writeZip(traversalZipPath)
    expect(installPluginPackage(traversalZipPath).ok).toBe(false)
    expect(listInstalledPlugins()).toHaveLength(0)

    const source = createPlugin()
    symlinkSync(join(root, 'source', 'dist', 'index.html'), join(root, 'source', 'dist', 'linked.html'))
    expect(installPluginPackage(source).ok).toBe(false)
    expect(listInstalledPlugins()).toHaveLength(0)
  })

  // Windows 会截断尾随空格/点并把 CON 这类名字当设备，这类条目必须在解压前拒绝。
  test('ZIP 中的 Windows 非法文件名被拒绝', () => {
    const source = createPlugin()
    const reservedZipPath = join(root, 'reserved-name.zip')
    const reservedZip = new AdmZip()
    reservedZip.addLocalFolder(source)
    reservedZip.addFile('CON.txt', Buffer.from('blocked'))
    reservedZip.writeZip(reservedZipPath)
    const reservedResult = installPluginPackage(reservedZipPath)
    expect(reservedResult.ok).toBe(false)
    expect(reservedResult.message).toContain('非法路径')
    expect(listInstalledPlugins()).toHaveLength(0)

    const trimmedZipPath = join(root, 'trimmed-suffix.zip')
    const trimmedZip = new AdmZip()
    trimmedZip.addLocalFolder(source)
    trimmedZip.addFile('dist/notes.txt ', Buffer.from('blocked'))
    trimmedZip.writeZip(trimmedZipPath)
    const trimmedResult = installPluginPackage(trimmedZipPath)
    expect(trimmedResult.ok).toBe(false)
    expect(trimmedResult.message).toContain('非法路径')
    expect(listInstalledPlugins()).toHaveLength(0)
  })

  test('安装路径超过预算时显式拒绝', () => {
    const source = createPlugin()
    const deepSegments = Array.from({ length: 8 }, (_, index) => `segment-${index}`.padEnd(24, 'x'))
    mkdirSync(join(source, ...deepSegments), { recursive: true })
    writeFileSync(join(source, ...deepSegments, 'payload.txt'), 'deep', 'utf8')
    const relativeLength = deepSegments.join('/').length + '/payload.txt'.length
    const targetLength = join(process.env.PROFER_CONFIG_DIR!, 'plugins', 'com.example.demo').length + 1 + relativeLength
    expect(targetLength).toBeGreaterThan(240)

    const result = installPluginPackage(source)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('安装路径过长')
    expect(listInstalledPlugins()).toHaveLength(0)
  })

  // 安装/更新/卸载被中断会留下 .install-* / .backup-* / .remove-* 目录，启动时应被回收。
  test('启动清理回收残留临时目录但保留新目录', async () => {
    const source = createPlugin()
    expect(installPluginPackage(source).ok).toBe(true)
    const pluginsDir = join(process.env.PROFER_CONFIG_DIR!, 'plugins')
    const staleInstall = join(pluginsDir, '.install-11111111-1111-1111-1111-111111111111')
    const staleRemove = join(pluginsDir, '.remove-22222222-2222-2222-2222-222222222222')
    const freshBackup = join(pluginsDir, '.backup-33333333-3333-3333-3333-333333333333')
    for (const directory of [staleInstall, staleRemove, freshBackup]) mkdirSync(directory, { recursive: true })
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(staleInstall, twoHoursAgo, twoHoursAgo)
    utimesSync(staleRemove, twoHoursAgo, twoHoursAgo)

    const removed = await cleanupStalePluginTempDirs()

    expect(removed.sort()).toEqual([staleInstall, staleRemove].sort())
    expect(existsSync(staleInstall)).toBe(false)
    expect(existsSync(staleRemove)).toBe(false)
    expect(existsSync(freshBackup)).toBe(true)
    expect(listInstalledPlugins()).toHaveLength(1)
  })
})
