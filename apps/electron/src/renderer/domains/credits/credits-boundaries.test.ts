import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const rendererRoot = resolve(import.meta.dir, '../..')

function inspectSource(path: string): { imports: string[]; hostCalls: string[]; fetchCalls: number } {
  const source = ts.createSourceFile(path, readFileSync(resolve(rendererRoot, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const result = { imports: [] as string[], hostCalls: [] as string[], fetchCalls: 0 }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) result.imports.push(node.moduleSpecifier.text)
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'electronAPI') result.hostCalls.push(node.getText(source))
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') result.fetchCalls++
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

describe('积分领域架构边界', () => {
  for (const path of [
    'components/settings/CreditsSettings.tsx',
    'components/settings/RechargeSection.tsx',
    'components/settings/SubscriptionSettings.tsx',
    'hooks/useCreditsLoader.ts',
    'domains/credits/credits-state.ts',
  ]) {
    test(`${path} 通过领域 API 访问宿主与网络`, () => {
      const source = inspectSource(path)
      expect(source.fetchCalls).toBe(0)
      expect(source.hostCalls).toEqual([])
    })
  }
  test('传输层不依赖 React、Jotai、atoms 或 hooks', () => {
    const source = inspectSource('domains/credits/credits-api.ts')
    expect(source.imports).toEqual(['./credits-types'])
  })
  test('契约层没有运行时状态依赖', () => {
    expect(inspectSource('domains/credits/credits-types.ts').imports).toEqual([])
  })
})
