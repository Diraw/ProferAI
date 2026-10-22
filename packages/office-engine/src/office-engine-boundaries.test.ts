/**
 * 边界门禁：锁定 @profer/office-engine 的架构约束。
 *
 * 既有模块化原则要求「边界要可被测试锁住」。`check-boundaries` 只覆盖包间依赖方向，
 * 且**不检查传递依赖**，因此本包自带一份更严的断言：
 *  1. 主入口 src/index.ts 不依赖任何 node 内置模块（保证浏览器安全，零运行时）；
 *  2. 包内任何文件不 import 'electron'；
 *  3. 包内任何文件不逃逸到 apps/ 或包外相对路径；
 *  4. 包内 @profer/* import 仅限 '@profer/shared'（须与 package.json dependencies 一致）。
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const srcRoot = import.meta.dir

function listSources(): string[] {
  return readdirSync(srcRoot)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => resolve(srcRoot, name))
}

/** 收集一个文件里的全部模块说明符：静态 import/export、以及动态 import() */
function importSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const result: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) result.push(arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

describe('@profer/office-engine 边界门禁', () => {
  test('主入口 index.ts 不依赖任何 node 内置模块（浏览器安全）', () => {
    const specifiers = importSpecifiers(resolve(srcRoot, 'index.ts'))
    expect(specifiers.filter((s) => s.startsWith('node:') || s === 'electron')).toEqual([])
  })

  test('包内任何文件不 import electron', () => {
    for (const file of listSources()) {
      const offenders = importSpecifiers(file).filter((s) => s === 'electron' || s.startsWith('electron/'))
      expect(offenders).toEqual([])
    }
  })

  test('包内任何文件不逃逸到 apps/ 或包外相对路径', () => {
    for (const file of listSources()) {
      const escaping = importSpecifiers(file).filter((s) => s.startsWith('..') || s.includes('apps/'))
      expect(escaping).toEqual([])
    }
  })

  test('@profer/* 依赖仅限 @profer/shared（与 package.json dependencies 一致）', () => {
    const allowed = new Set(['@profer/shared'])
    for (const file of listSources()) {
      for (const spec of importSpecifiers(file).filter((s) => s.startsWith('@profer/'))) {
        const pkgName = spec.split('/').slice(0, 2).join('/')
        expect(allowed.has(pkgName)).toBe(true)
      }
    }
  })

  test('运行时入口 node.ts 存在且导出 parseOfficeBuffer', () => {
    const source = readFileSync(resolve(srcRoot, 'node.ts'), 'utf8')
    expect(source).toContain('export function parseOfficeBuffer')
  })
})
