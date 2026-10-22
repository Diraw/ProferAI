/**
 * runtime-migration-parity / 源码切片编译设施
 *
 * 目的：在**不启动 Electron、不写磁盘、不加载真实 provider SDK** 的前提下，执行
 * `apps/electron/src/main/lib` 中的真实生产源码。
 *
 * 为什么必须切片编译：
 * - `agent-orchestrator.ts` 与 `agent-service.ts` 之间存在模块循环
 *   （orchestrator → agent-collaboration-tools → agent-service → orchestrator），
 *   直接 `import` 会在模块初始化期抛
 *   `ReferenceError: Cannot access 'AgentOrchestrator' before initialization`。
 * - 两个文件在模块顶层创建 Electron 单例与真实 adapter 实例，import 即产生副作用。
 *
 * 设施与既有 `agent-goal-runtime-bridge.test.ts` 同源（`Bun.Transpiler` + `new Function`
 * 注入依赖），本文件把它抽成可复用模块，使对照测试不必各自复制。
 */

import { readFileSync } from 'node:fs'

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })

/** 切片标记失效时立刻失败，避免"切到空串却静默通过"的假绿。 */
export class SliceMarkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SliceMarkerError'
  }
}

/**
 * 编译一段真实生产源码并返回其中的符号。
 *
 * 依赖以函数参数注入，因此切片里引用的所有模块级符号都必须出现在 `dependencies`
 * 中；漏注入的符号只会在运行到该行时以 `ReferenceError` 暴露（编译期不报错）。
 */
export function compileSlice<T>(source: string, symbol: string, dependencies: Record<string, unknown>): T {
  // `new Function` body 不接受 `export`/`export default`，统一剥离关键字。
  const compiled = transpiler.transformSync(source.replace(/\bexport\s+/g, ''))
  try {
    return new Function(
      ...Object.keys(dependencies),
      `${compiled}\nreturn ${symbol}`,
    )(...Object.values(dependencies)) as T
  } catch (error) {
    throw new Error(
      `compileSlice(${symbol}) 失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** 读取 main/lib 下的真实源码（相对路径，如 `agent-service.ts` 或 `../ipc.ts`）。 */
export function readMainSource(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

/**
 * 按起止标记切出源码片段。起止标记都必须命中，否则抛 `SliceMarkerError`。
 * `endMarker` 省略时切到 source 末尾。
 */
export function sliceBetween(
  source: string,
  startMarker: string,
  endMarker?: string,
  label = 'slice',
): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new SliceMarkerError(`${label}: 起点标记失效 → ${JSON.stringify(startMarker)}`)
  if (endMarker === undefined) return source.slice(start)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new SliceMarkerError(`${label}: 终点标记失效 → ${JSON.stringify(endMarker)}`)
  return source.slice(start, end)
}

/** 断言源码切片包含全部给定片段（用于把"路由条件"固化成可执行证据）。 */
export function expectSnippets(source: string, snippets: readonly string[], label = 'source'): void {
  for (const snippet of snippets) {
    if (!source.includes(snippet)) {
      throw new SliceMarkerError(`${label}: 缺少预期片段 → ${JSON.stringify(snippet)}`)
    }
  }
}

/** 统计某标记在源码中出现的次数（例如环境开关的读取点）。 */
export function countOccurrences(source: string, marker: string): number {
  return source.split(marker).length - 1
}
