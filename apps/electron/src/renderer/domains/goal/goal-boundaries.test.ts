import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const rendererRoot = resolve(import.meta.dir, '../..')

function imports(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(resolve(rendererRoot, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const result: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

describe('Goal renderer domain boundaries', () => {
  test('Goal 显示策略不依赖 React、Jotai、组件或宿主 API', () => {
    const importsFound = imports('domains/goal/goal-display-policy.ts')
    expect(importsFound).not.toContain('react')
    expect(importsFound).not.toContain('jotai')
    expect(importsFound.some((item) => item.includes('components/'))).toBe(false)
    expect(importsFound.some((item) => item.includes('electronAPI'))).toBe(false)
  })
})
