/**
 * 浏览器列里的独立文件预览页（Open File Viewer 宿主）。
 *
 * 为什么是独立页面而不是复用 app 渲染进程：受管浏览器的 WebContentsView 是
 * `sandbox: true / contextIsolation / nodeIntegration: false / **无 preload**` 的独立 web contents
 * —— 它拿不到任何 Electron 能力，因此这里引用的文件必须是主进程签发的 `profer-file://<token>` URL。
 * 这正是 OFV 需要的安全边界：OFV 内部有未过 DOMPurify 的 docx 主路径（其 issue #140），
 * 在这一层即使被注入也够不到 app 的 preload / IPC。
 *
 * 参数（由主进程的 `createViewerPreviewUrl` 拼出）：
 * - `src`    已授权的 profer-file URL（或 dev 下的 http 地址）
 * - `name`   文件名（用于标题与 OFV 的插件分派 —— profer-file URL 没有扩展名）
 * - `theme`  light | dark（跟随 app 皮肤，而不是 OS）
 * - `tokens` app 文档上**实际生效**的 Profer token 值（JSON）。皮肤配色靠它到达这一页：
 *   本页读不到 app 的设置与文档变量（无 preload、且与 app 不同 origin），只能由主进程烘进 URL。
 *   名单与校验在 `@profer/shared` 的 ofv-theme-bridge（与主进程、渲染进程同一份契约）。
 *
 * 工具栏：去打印与搜索、加「用默认应用打开」，配置在 `@/lib/ofv-toolbar`（与 app 内回退路径共用）。
 *
 * 本页向 app 的两条回投都只能借哨兵 URL（无 preload）：
 * 「用默认应用打开」与「用户划词 → 对话引用」，常量定义在 `@profer/shared` 的
 * `browser-file-sentinels`，主进程按同一份定义放行。
 */
import { createViewer, type FileViewer } from '@open-file-viewer/core'
// 字体与 OFV 基础样式先加载，Profer 桥接样式放最后，保证同特异度时由我们决胜
import '@fontsource-variable/inter/index.css'
import '@open-file-viewer/core/style.css'
import '@/styles/ofv-profer-theme.css'
import {
  BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX,
  encodeBrowserLocalFileSelection,
  parseOfvThemeTokens,
} from '@profer/shared'
import { createOfvPlugins } from '@/lib/ofv-plugins'
import { createOfvToolbarOptions } from '@/lib/ofv-toolbar'

/**
 * 反馈延迟：拖拽选词时 selectionchange 会连发，等它静默一小会儿再回投，
 * 避免把中间态碎片一路送到对话里。180ms 对「松手即引用」足够跟手。
 */
const SELECTION_REPORT_DELAY_MS = 180

/**
 * 把划词交给 app。
 *
 * 本页无 preload，只能用哨兵 URL 开窗 —— 主进程拦下这个 URL（不会真的导航），
 * 把文本转给渲染进程，渲染进程写成对话里的引用。用户松手后选区才生效，
 * 所以这里等一小段静默期；选区清空也要回投一次（空串），让 app 撤掉引用。
 */
function installSelectionReporter(): void {
  let lastReported = ''
  let timer: number | null = null

  /** 选区两端都落在 OFV 工具栏里 = 误拖过工具栏，不算划词，别把它带进对话。 */
  const isToolbarSelection = (selection: Selection): boolean => {
    const inside = (node: Node | null): boolean =>
      !!node && !!node.parentElement?.closest('.ofv-toolbar')
    return inside(selection.anchorNode) && inside(selection.focusNode)
  }

  const report = () => {
    timer = null
    const selection = window.getSelection()
    const text = (selection?.toString() ?? '').trim()
    if (text === lastReported) return
    if (!text && !lastReported) return
    if (text && selection && isToolbarSelection(selection)) return
    lastReported = text
    window.open(encodeBrowserLocalFileSelection(text), '_blank')
  }

  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(report, SELECTION_REPORT_DELAY_MS)
  }

  // selectionchange 覆盖鼠标拖选与键盘选择；选区被点掉时同样会触发，用来撤销引用。
  document.addEventListener('selectionchange', schedule)
  window.addEventListener('beforeunload', () => {
    if (timer !== null) window.clearTimeout(timer)
  })
}

function showFallback(message: string): void {
  const host = document.getElementById('host')
  const fallback = document.getElementById('fallback')
  if (host) host.style.display = 'none'
  if (fallback) {
    fallback.style.display = 'grid'
    // 逐节点写入，避免把 OFV 的错误文本当 HTML 注入
    const box = document.createElement('div')
    box.className = 'ofv-profer-empty'
    const title = document.createElement('div')
    title.className = 'ofv-profer-empty-title'
    title.textContent = '无法预览这个文件'
    const detail = document.createElement('div')
    detail.className = 'ofv-profer-empty-detail'
    detail.textContent = message
    box.append(title, detail)
    fallback.replaceChildren(box)
  }
}

/**
 * 把主进程烘进 URL 的主题落到页面上：明暗类 + token 内联变量 + 兜底镜像的作用域类。
 *
 * token 写成 `<html>` 内联变量（优先级高于 `ofv-profer-theme.css` 的兜底镜像），
 * 于是 app 里那套 `--ofv-*` 映射在这一页原样成立 —— 皮肤（含用户自定义皮肤）的配色就到场了。
 * 幂等：首帧脚本（viewer.html）已经做过同样的事，这里用校验过的值再落一遍。
 */
function applyPageTheme(params: URLSearchParams): 'light' | 'dark' {
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const root = document.documentElement
  root.classList.add('viewer-page')
  root.classList.toggle('dark', theme === 'dark')
  const tokens = parseOfvThemeTokens(params.get('tokens'))
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(`--${name}`, value)
  return theme
}

function main(): void {
  const params = new URLSearchParams(window.location.search)
  const src = params.get('src') ?? ''
  const name = params.get('name') ?? ''
  const theme = applyPageTheme(params)
  if (name) document.title = name
  if (!src) {
    showFallback('缺少文件地址：主进程未提供受控的本地文件 URL。')
    return
  }
  const host = document.getElementById('host')
  if (!host) return
  try {
    installSelectionReporter()
    const viewer: FileViewer = createViewer({
      container: host,
      file: src,
      fileName: name,
      plugins: createOfvPlugins(),
      theme,
      locale: 'zh-CN',
      toolbar: createOfvToolbarOptions(),
      onError: (error: Error) => showFallback(`预览失败：${error?.message ?? '未知错误'}`),
    })
    window.addEventListener('beforeunload', () => viewer.destroy())
  } catch (error) {
    showFallback(`预览失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

main()
