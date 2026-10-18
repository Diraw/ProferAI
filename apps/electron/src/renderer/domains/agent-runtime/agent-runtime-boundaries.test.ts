import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const rendererRoot = resolve(import.meta.dir, '../..')

function imports(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(resolve(rendererRoot, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const result: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('Agent runtime 显示 domain 只依赖纯类型与自身逻辑，不依赖页面、React、Jotai 或宿主', () => {
  const paths = ['domains/agent-runtime/agent-runtime-display-policy.ts']
  for (const path of paths) {
    const pathsFound = imports(path)
    expect(pathsFound).not.toContain('react')
    expect(pathsFound).not.toContain('jotai')
    expect(pathsFound.some((item) => item.includes('components/'))).toBe(false)
    expect(pathsFound.some((item) => item.includes('electronAPI'))).toBe(false)
  }
})

test('消息组件通过 runtime display domain 接入活跃状态，不再直接实现状态优先级', () => {
  const pathsFound = imports('components/agent/AgentMessages.tsx')
  expect(pathsFound).toContain('@/domains/agent-runtime/agent-runtime-display-policy')
})
