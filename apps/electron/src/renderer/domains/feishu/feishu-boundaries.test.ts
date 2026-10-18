import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const rendererRoot = resolve(import.meta.dir, '../..')

function inspectSource(path: string): { imports: string[]; hostCalls: string[] } {
  const source = ts.createSourceFile(path, readFileSync(resolve(rendererRoot, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const result = { imports: [] as string[], hostCalls: [] as string[] }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) result.imports.push(node.moduleSpecifier.text)
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'electronAPI') result.hostCalls.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('Feishu 设置页通过 domain API 访问宿主，不直接触碰 electronAPI', () => {
  const source = inspectSource('components/settings/FeishuSettings.tsx')
  expect(source.hostCalls).toEqual([])
  expect(source.imports).toContain('@/domains/feishu/feishu-api')
})

test('Feishu 域的 API 层不依赖 React、Jotai 或页面组件', () => {
  const source = inspectSource('domains/feishu/feishu-api.ts')
  expect(source.imports).not.toContain('react')
  expect(source.imports).not.toContain('jotai')
  expect(source.imports.some((path) => path.includes('components/'))).toBe(false)
})
