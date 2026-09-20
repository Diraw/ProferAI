import { existsSync, realpathSync, statSync } from 'node:fs'
import { app } from 'electron'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { serializeOfvThemeTokens, type OfvThemePayload, type OfvThemeTokens } from '@profer/shared'
import { expandHomeDirectory } from './file-preview-service'
import { isReadOnlyPreviewPathAllowed } from './preview-path-policy'
import { registerProferDirectoryPath, registerProferFilePath } from './local-file-protocol'
import { VITE_DEV_SERVER_URL } from './config-paths'

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function realDirectory(path: string): string {
  const resolved = realpathSync(resolve(path))
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`本地预览根目录不存在或不是目录: ${path}`)
  return resolved
}

/** 无法解析或不是目录的授权根直接略过：一个失效根不应该让整次本地预览失败。 */
function realDirectoryOrNull(path: string): string | null {
  try {
    return realDirectory(path)
  } catch {
    return null
  }
}

/**
 * 把已授权根目录内的 HTML 文件转换为一次性/短期 profer-file 目录 URL。
 * 不接受 file://，也不把绝对路径暴露给 renderer 或模型。
 *
 * 授权根之外的本地 HTML 按只读预览策略放行（系统与凭据敏感位置仍拒绝），
 * 与聊天里文件链接的预览边界保持一致。
 */
export function createAuthorizedPreviewUrl(inputPath: string, allowedRoots: string[], baseDir?: string): { url: string; filePath: string } {
  if (!inputPath.trim()) throw new Error('本地预览路径不能为空。')
  // Agent 输出常用 `~/...` 写法，先展开为真实 home 再解析
  const target = realpathSync(resolve(baseDir ?? process.cwd(), expandHomeDirectory(inputPath.trim())))
  const targetStat = statSync(target)
  const roots = allowedRoots.map(realDirectoryOrNull).filter((root): root is string => Boolean(root))
  const authorizedRoot = roots.find((candidate) => isInside(target, candidate))
  // 不在授权根时退回自己的目录作为边界：页面只能读它所在目录及其子目录，与授权根内的预览同构。
  const root = authorizedRoot ?? (isReadOnlyPreviewPathAllowed(target) ? dirname(target) : null)
  if (!root) throw new Error('本地预览路径不在当前 Agent 已授权的项目或附加目录内。')

  let filePath = target
  if (targetStat.isDirectory()) {
    const indexCandidates = ['index.html', 'index.htm']
    const indexPath = indexCandidates.map((name) => resolve(target, name)).find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
    if (!indexPath) throw new Error('本地预览目录中没有 index.html 或 index.htm。')
    filePath = realpathSync(indexPath)
  }
  const extension = extname(filePath).toLowerCase()
  if (!['.html', '.htm'].includes(extension)) throw new Error(`只支持 HTML 本地预览，当前文件为 ${basename(filePath)}。`)
  if (!isInside(filePath, root)) throw new Error('本地预览文件越过了授权目录边界。')

  const directoryUrl = registerProferDirectoryPath(dirname(filePath))
  const relativeFile = relative(dirname(filePath), filePath).split(sep).map(encodeURIComponent).join('/')
  return { url: `${directoryUrl}/${relativeFile}`, filePath }
}

export function isAuthorizedPreviewProtocol(url: string): boolean {
  return url.startsWith('profer-file://')
}

/** 打包后 viewer 页与主进程产物同级的 renderer/ 目录（约定与 agent-preview-renderer 一致） */
const PACKAGED_RENDERER_DIR = join(__dirname, 'renderer')

/**
 * 烘进 viewer URL 的 Profer 主题参数。
 *
 * - `theme`：只决定 OFV 自己的 `ofv-theme-*` 类与页面 `color-scheme`；
 * - `tokens`：app 文档上真实生效的 Profer token 值（渲染进程算好、IPC 边界已校验）。
 *   viewer 页把它们写成 `<html>` 内联变量，`ofv-profer-theme.css` 再映射到 `--ofv-*`，
 *   于是皮肤（含用户自定义皮肤）的配色也能到达那一页。
 *
 * 类型直接用 shared 的载荷契约（`OfvThemePayload`）—— 跨进程只维护一份定义。
 * 两项都缺省时页面回落到主题自带默认色（见 `ofv-profer-theme.css` 的 viewer 兜底镜像）。
 */
export type ViewerPreviewTheme = OfvThemePayload

/**
 * 主题参数签名：判断「某个标签当前 URL 里烘的是不是这套主题」的**唯一**口径。
 *
 * 序列化结果键序固定（见 `serializeOfvThemeTokens`），所以同一套主题必然得到同一个字符串；
 * 皮肤之间色调相同时（两个深色皮肤）也要能判出差异 —— 这正是只比对 light/dark 会漏掉的情况。
 */
export function viewerPreviewThemeSignature(previewTheme: ViewerPreviewTheme): string {
  return `${previewTheme.theme ?? ''}|${serializeOfvThemeTokens(previewTheme.tokens ?? {}) ?? ''}`
}

/**
 * 把已授权文件转成「浏览器列里的 viewer 页 URL」。
 *
 * - dev：命中 Vite dev server 的 `/viewer.html`（该页由 vite.config 的多入口构建产出）；
 * - 打包：把 renderer 目录注册成 token，加载 `profer-file://<token>/viewer.html`。
 *
 * 文件本身用**另一个** token（`registerProferFilePath`）作为 `?src=`，
 * 因此页面（以及任何在其中渲染的内容）永远拿不到绝对路径 —— 与 HTML 预览同一条边界。
 *
 * `previewTheme` 会以 `?theme=` / `?tokens=` 烘进 URL：那一页没有 preload，主题只能这样递进去。
 * 主题变了就得用新参数**重新生成 URL 并重载**（见 `browser-controller.refreshLocalPreviewThemes`）。
 */
export function createViewerPreviewUrl(
  inputPath: string,
  allowedRoots: string[],
  baseDir?: string,
  previewTheme: ViewerPreviewTheme = {},
): { url: string; filePath: string } {
  if (!inputPath.trim()) throw new Error('本地预览路径不能为空。')
  const target = realpathSync(resolve(baseDir ?? process.cwd(), expandHomeDirectory(inputPath.trim())))
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`本地预览文件不存在或不是文件: ${inputPath}`)
  const roots = allowedRoots.map(realDirectoryOrNull).filter((root): root is string => Boolean(root))
  const authorized = roots.some((root) => isInside(target, root)) || isReadOnlyPreviewPathAllowed(target)
  if (!authorized) throw new Error('本地预览路径不在当前 Agent 已授权的项目或附加目录内。')

  const fileTokenUrl = registerProferFilePath(target)
  const base = app.isPackaged
    ? `${registerProferDirectoryPath(PACKAGED_RENDERER_DIR)}/viewer.html`
    : `${VITE_DEV_SERVER_URL.replace(/\/$/, '')}/viewer.html`
  const tokens = serializeOfvThemeTokens(previewTheme.tokens ?? {})
  const query = new URLSearchParams({
    src: fileTokenUrl,
    name: basename(target),
    ...(previewTheme.theme ? { theme: previewTheme.theme } : {}),
    ...(tokens ? { tokens } : {}),
  })
  return { url: `${base}?${query.toString()}`, filePath: target }
}
