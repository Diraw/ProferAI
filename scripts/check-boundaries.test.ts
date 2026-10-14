import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isPathWithin, workspaceRootOf } from './check-boundaries-paths'

for (const [name, pathOps, root] of [
  ['POSIX', posix, '/workspace/Profer main'],
  ['Windows C', win32, 'C:\\workspace\\Profer main'],
  ['Windows D', win32, 'D:\\workspace\\Profer main'],
] as const) {
  describe(`${name} workspace 路径规则`, () => {
    const uiRoot = pathOps.join(root, 'packages', 'ui')

    test('定位 packages 和 apps 的所属 workspace', () => {
      expect(workspaceRootOf(root, pathOps.join(uiRoot, 'src', 'index.ts'), pathOps)).toBe(uiRoot)
      expect(workspaceRootOf(root, pathOps.join(root, 'apps', 'cli', 'src', 'index.ts'), pathOps))
        .toBe(pathOps.join(root, 'apps', 'cli'))
      expect(workspaceRootOf(root, pathOps.join(root, 'scripts', 'test.ts'), pathOps)).toBe(root)
    })

    test('允许根目录及内部导入，包含以两个点开头的合法目录名', () => {
      expect(isPathWithin(uiRoot, uiRoot, pathOps)).toBe(true)
      expect(isPathWithin(uiRoot, pathOps.join(uiRoot, 'src', 'lib', 'cn.ts'), pathOps)).toBe(true)
      expect(isPathWithin(uiRoot, pathOps.join(uiRoot, '..cache', 'index.ts'), pathOps)).toBe(true)
    })

    test('拒绝父目录越界和同名前缀的相邻目录', () => {
      expect(isPathWithin(uiRoot, pathOps.dirname(uiRoot), pathOps)).toBe(false)
      expect(isPathWithin(uiRoot, pathOps.join(root, 'packages', 'ui-extra', 'index.ts'), pathOps)).toBe(false)
      expect(isPathWithin(pathOps.join(root, 'apps'), pathOps.join(root, 'apps-extra', 'index.ts'), pathOps))
        .toBe(false)
    })
  })
}

test('Windows 跨盘路径不属于根目录', () => {
  expect(isPathWithin('C:\\repo\\packages\\ui', 'D:\\repo\\packages\\ui\\src\\index.ts', win32))
    .toBe(false)
})

test('Windows 同盘路径按本机语义忽略大小写', () => {
  expect(isPathWithin('C:\\Repo\\packages\\ui', 'c:\\repo\\packages\\UI\\src\\index.ts', win32))
    .toBe(true)
})

function runFixture(source: string): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'profer boundaries 中文 '))
  try {
    for (const dir of ['scripts', 'packages/ui/src', 'apps/cli/src', 'apps/electron/src/renderer']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    for (const [dir, name] of [
      ['', 'fixture'], ['packages/ui', '@profer/ui'], ['apps/cli', '@profer/cli'], ['apps/electron', '@profer/electron'],
    ] as const) {
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({
        name, dependencies: {}, exports: { '.': './src/index.ts' },
      }))
    }
    for (const name of ['check-boundaries.ts', 'check-boundaries-paths.ts']) {
      copyFileSync(join(import.meta.dir, name), join(root, 'scripts', name))
    }
    writeFileSync(join(root, 'packages/ui/src/index.ts'), source)
    const result = spawnSync(process.execPath, [join(root, 'scripts/check-boundaries.ts')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    })
    if (result.error) throw result.error
    return { status: result.status, output: result.stdout + result.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('实际边界检查入口（空格和中文路径）', () => {
  test('合法的内部引用通过', () => {
    const result = runFixture("export { cn } from './lib/cn'\n")
    expect(result.status).toBe(0)
    expect(result.output).toContain('无边界违规')
  })

  test('跨 workspace 的相对引用仍被 R5 和 R2 拒绝', () => {
    const result = runFixture("import '../../../apps/cli/src/index'\n")
    expect(result.status).toBe(1)
    expect(result.output).toContain('[R5]')
    expect(result.output).toContain('[R2]')
  })

  test('未声明的共享依赖仍被 R3 拒绝', () => {
    const result = runFixture("import '@profer/core'\n")
    expect(result.status).toBe(1)
    expect(result.output).toContain('[R3]')
    expect(result.output).toContain('@profer/ui 未在 dependencies 声明')
  })
})
