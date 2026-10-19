import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const libRoot = resolve(import.meta.dir, '..')

function importsOf(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(libRoot, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const specifiers: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

const executionChain = [
  'chat-service.ts',
  'agent-orchestrator.ts',
  'agent-runtime-credentials.ts',
  'plugins/plugin-models.ts',
]

const commercialModules = new Set([
  './auth-service',
  '../auth-service',
  './commercial-routing-policy',
  '../commercial-routing-policy',
  './build-target',
  '../build-target',
  './official-channel',
  '../official-channel',
])

describe('执行链商业依赖边界', () => {
  for (const file of executionChain) {
    test(`${file} 只通过 edition 契约访问商业能力`, () => {
      const violations = importsOf(file).filter((specifier) => commercialModules.has(specifier))
      expect(violations).toEqual([])
    })
  }
})
