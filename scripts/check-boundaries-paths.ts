import { isAbsolute, join, relative } from 'node:path'

export interface PathOperations {
  relative: (from: string, to: string) => string
  isAbsolute: (value: string) => boolean
  join: (...parts: string[]) => string
}

export const nativePathOperations: PathOperations = { relative, isAbsolute, join }

/** 将 Windows/POSIX 相对路径统一成用于规则匹配的斜杠形式。 */
export function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/')
}

/** 判断 target 是否位于 root 内，避免同名前缀目录误判。 */
export function isPathWithin(
  root: string,
  target: string,
  pathOps: PathOperations = nativePathOperations,
): boolean {
  const rel = pathOps.relative(root, target)
  const normalized = normalizePathSeparators(rel)
  return !pathOps.isAbsolute(rel) && normalized !== '..' && !normalized.startsWith('../')
}

/** 根据仓库相对路径定位所属 workspace 根目录。 */
export function workspaceRootOf(
  root: string,
  file: string,
  pathOps: PathOperations = nativePathOperations,
): string {
  const rel = normalizePathSeparators(pathOps.relative(root, file))
  const match = rel.match(/^(packages|apps)\/[^/]+/)
  return match ? pathOps.join(root, ...match[0].split('/')) : root
}
