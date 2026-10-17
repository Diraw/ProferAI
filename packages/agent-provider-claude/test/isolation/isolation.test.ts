/**
 * Claude provider 边界回归守卫（GAP-7 E1）。
 *
 * 断言的不是「源码里没有某个字符串」，而是：
 * 1. `src/**` 里**真实出现**的 import / 动态 import 不含另一个 provider 的 SDK 与 Electron；
 * 2. 包清单声明的依赖 / peer 依赖里没有禁用项；
 * 3. `check:isolation` 脚本存在且指向本目录的真实沙箱验证器；
 * 4. 反证：禁用项检测函数对本组合的禁用清单**确实返回 true**（否则上面的「无违规」没有区分度）。
 *
 * 完整缺席验证（仓库之外的 tmpdir 沙箱 + 真实解析 + 构建 + 加载）见 `run-isolation-check.ts`。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '..', '..')

/** 另一个 provider 的 SDK（含 typebox）与 Electron：Claude 发行组合里必须完全缺席。 */
const FORBIDDEN_SPECIFIERS = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  'typebox',
  'electron',
] as const

/** 本组合必须能解析的自有 SDK。 */
const OWN_SDK_SPECIFIERS = ['@anthropic-ai/claude-agent-sdk'] as const

export function isForbiddenSpecifier(specifier: string): boolean {
  return FORBIDDEN_SPECIFIERS.some(name => specifier === name || specifier.startsWith(`${name}/`))
}

const SPECIFIER_PATTERN = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) listSourceFiles(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('Claude provider 发行组合边界', () => {
  test('Given src 源码 When 扫描真实 import Then 没有另一个 SDK 或 Electron', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(join(packageDir, 'src'))) {
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const match of source.matchAll(SPECIFIER_PATTERN)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        if (specifier && isForbiddenSpecifier(specifier)) {
          offenders.push(`${file.slice(packageDir.length + 1)} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('Given 包清单 When 检查声明依赖 Then 没有另一个 SDK 或 Electron', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    expect(declared.filter(isForbiddenSpecifier)).toEqual([])
    // 自有 SDK 必须真的声明为依赖，否则「可解析」是环境巧合。
    expect(Object.keys(manifest.dependencies ?? {}).filter(specifier => OWN_SDK_SPECIFIERS.includes(specifier as typeof OWN_SDK_SPECIFIERS[number]))).toEqual([...OWN_SDK_SPECIFIERS])
  })

  test('Given 包清单 When 检查脚本 Then check:isolation 指向本目录沙箱验证器', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(manifest.scripts?.['check:isolation']).toBe('bun run test/isolation/run-isolation-check.ts')
    expect(existsSync(join(packageDir, 'test', 'isolation', 'run-isolation-check.ts'))).toBe(true)
  })

  test('反证：禁用项检测对本组合的禁用清单确实命中（不是恒 false 的空检查）', () => {
    for (const specifier of FORBIDDEN_SPECIFIERS) expect(isForbiddenSpecifier(specifier)).toBe(true)
    expect(isForbiddenSpecifier('@earendil-works/pi-ai/foo')).toBe(true)
    expect(isForbiddenSpecifier('electron/main')).toBe(true)
    // 自有依赖不得被误判为禁用项，否则检查会因为误报而永远失败。
    for (const specifier of OWN_SDK_SPECIFIERS) expect(isForbiddenSpecifier(specifier)).toBe(false)
  })

  test('Given 沙箱验证器 When 读取源码 Then 它确实在 tmpdir 里建沙箱并断言祖先', () => {
    const source = readFileSync(join(packageDir, 'test', 'isolation', 'run-isolation-check.ts'), 'utf8')
    expect(source).toContain("from 'node:os'")
    expect(source).toContain('mkdtempSync')
    expect(source).toContain('listAncestorNodeModules')
    expect(source).toContain('isolation-negative-probe')
  })
})
