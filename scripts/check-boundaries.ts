#!/usr/bin/env bun
/**
 * check-boundaries.ts — packages/apps 架构边界检查（零第三方依赖，bun 直跑）
 *
 * 强制规则（与模块化调研报告 2026-09-30 对齐）：
 *  1. packages/* 不得 import 'electron' 或 electron 子模块。
 *  2. packages/* 不得 import apps/*（相对路径逃逸或别名都算）。
 *  3. packages/* 之间只允许 import 自身 package.json dependencies 中声明的 @profer/* 包。
 *  4. @profer/* 的子路径 import（@profer/x/sub）必须命中目标包 package.json exports 声明。
 *  5. 任何文件不得通过相对路径逃逸出自己所属 workspace 根目录。
 *  6. apps/electron/src/renderer（渲染层）不得 import 'electron' 或 node 内置模块（node:* 及裸名）。
 *  7. apps/cli 只允许 import 自身 package.json 声明的 @profer/* 包。
 *
 * 用法：bun run check:boundaries
 * 退出码：0 无违规；1 存在违规。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPathWithin, workspaceRootOf } from './check-boundaries-paths'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 工具 ----------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

interface PkgInfo {
  dir: string
  name: string
  proferDeps: Set<string>
  exportsKeys: Set<string>
}

const pkgCache = new Map<string, PkgInfo>()

function loadPkg(dir: string): PkgInfo {
  const cached = pkgCache.get(dir)
  if (cached) return cached
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const proferDeps = new Set<string>(
    Object.keys(json.dependencies ?? {}).filter((d: string) => d.startsWith('@profer/')),
  )
  const exportsKeys = new Set<string>(Object.keys(json.exports ?? { '.': true }))
  const info: PkgInfo = { dir, name: json.name, proferDeps, exportsKeys }
  pkgCache.set(dir, info)
  return info
}

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
])

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g

function collectSpecifiers(file: string): Array<{ spec: string; line: number }> {
  const src = readFileSync(file, 'utf8')
  // 粗去注释，避免注释里的示例 import 误报
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const specs: Array<{ spec: string; line: number }> = []
  for (const match of stripped.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec) continue
    const line = stripped.slice(0, match.index).split('\n').length
    specs.push({ spec, line })
  }
  return specs
}

// ---------- 规则执行 ----------

interface Violation {
  file: string
  line: number
  rule: string
  detail: string
}

const violations: Violation[] = []

function report(file: string, line: number, rule: string, detail: string): void {
  violations.push({ file: relative(ROOT, file), line, rule, detail })
}

function checkFile(file: string, scope: 'package' | 'renderer' | 'electron-non-renderer' | 'cli'): void {
  const wsRoot = workspaceRootOf(ROOT, file)
  const pkg = loadPkg(wsRoot)
  // 测试文件跑在 bun/node 环境而非 renderer bundle，豁免 R6
  const effectiveScope = scope === 'renderer' && /\.(?:test|spec)\.(?:ts|tsx)$/.test(file) ? 'electron-non-renderer' : scope
  for (const { spec, line } of collectSpecifiers(file)) {
    // 规则 1/6：electron 与 node 内置
    if (spec === 'electron' || spec.startsWith('electron/')) {
      if (effectiveScope === 'package') report(file, line, 'R1', `packages 不得 import '${spec}'`)
      if (effectiveScope === 'renderer') report(file, line, 'R6', `renderer 不得 import '${spec}'`)
    }
    const bare = spec.replace(/^node:/, '').split('/')[0] ?? ''
    if (effectiveScope === 'renderer' && (spec.startsWith('node:') || NODE_BUILTINS.has(bare))) {
      report(file, line, 'R6', `renderer 不得 import node 内置模块 '${spec}'`)
    }

    // @profer/* 引用
    if (spec.startsWith('@profer/')) {
      const parts = spec.split('/')
      const targetName = `${parts[0]}/${parts[1]}`
      const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.'
      if ((effectiveScope === 'package' || effectiveScope === 'cli') && targetName !== pkg.name && !pkg.proferDeps.has(targetName)) {
        report(file, line, effectiveScope === 'cli' ? 'R7' : 'R3', `${pkg.name} 未在 dependencies 声明 '${targetName}'`)
      }
      // 规则 4：子路径必须命中目标包 exports（支持尾通配 `./x/*`）
      const targetDir = join(ROOT, 'packages', parts[1]!)
      if (existsSync(join(targetDir, 'package.json'))) {
        const target = loadPkg(targetDir)
        const matched = [...target.exportsKeys].some(
          (k) => k === subpath || (k.endsWith('/*') && subpath.startsWith(k.slice(0, -1))),
        )
        if (!matched) {
          report(file, line, 'R4', `'${spec}' 未命中 ${targetName} 的 exports（允许：${[...target.exportsKeys].join(', ')}）`)
        }
      }
      continue
    }

    // 相对路径：不得逃逸出所属 workspace
    if (spec.startsWith('.')) {
      const resolved = resolve(dirname(file), spec)
      if (!isPathWithin(wsRoot, resolved)) {
        report(file, line, 'R5', `相对引用 '${spec}' 逃逸出 ${relative(ROOT, wsRoot)}`)
      }
      // 规则 2：packages 内相对引用不得指向 apps
      if (scope === 'package' && isPathWithin(join(ROOT, 'apps'), resolved)) {
        report(file, line, 'R2', `packages 不得引用 apps：'${spec}'`)
      }
    }
  }
}

// packages/*
for (const entry of readdirSync(join(ROOT, 'packages'))) {
  const srcDir = join(ROOT, 'packages', entry, 'src')
  for (const file of walk(srcDir)) checkFile(file, 'package')
}

// apps/cli
for (const file of walk(join(ROOT, 'apps/cli/src'))) checkFile(file, 'cli')

// apps/electron：renderer 单独规则，main/preload 仅做逃逸检查
for (const file of walk(join(ROOT, 'apps/electron/src/renderer'))) checkFile(file, 'renderer')
for (const file of walk(join(ROOT, 'apps/electron/src/main'))) checkFile(file, 'electron-non-renderer')
for (const file of walk(join(ROOT, 'apps/electron/src/preload'))) checkFile(file, 'electron-non-renderer')

// ---------- 输出 ----------

if (violations.length === 0) {
  console.log('check-boundaries: ✅ 无边界违规')
  process.exit(0)
}

console.error(`check-boundaries: ❌ ${violations.length} 处边界违规\n`)
for (const v of violations) {
  console.error(`  [${v.rule}] ${v.file}:${v.line}\n      ${v.detail}`)
}
process.exit(1)
