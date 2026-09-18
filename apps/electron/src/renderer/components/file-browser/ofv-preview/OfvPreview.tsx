/**
 * OfvPreview — Open File Viewer（@open-file-viewer/core）在 Profer 预览面里的宿主。
 *
 * 本轮范围：承担 Profer 现有链路覆盖不到的格式 ——
 * - 老式 Office（.doc / .xls / .ppt）：此前 `DiffTabContent` 直接渲染 `null`，也就是**一片空白**；
 * - 长尾格式（归档 / 设计文件 / 3D / GIS / 电子书 / 邮件 / OFD·XPS / 绘图 / 数据…）：此前归入 `UNSUPPORTED_EXTS`。
 * 现有可用路径（markdown / html / pdf / 图片 / .docx·.xlsx·.pptx 的 WASM 预览）暂不经过本组件，
 * 因此这条接线是纯增益：不改动任何当前可用的预览行为。
 *
 * 四个刻意的取舍：
 * 1. **插件白名单**：OFV 默认只挂 `fallbackPlugin`，插件必须显式传入（见其 `createViewer` 实现：
 *    `plugins = [...options.plugins || [], fallbackPlugin()]`）。而它的重依赖是**字面量动态 import**
 *    （three / mermaid / hls.js / ag-psd / xlsx / pdfjs-dist / leaflet / prismjs 45 种语言…），
 *    Vite 会为它们全部生成异步 chunk —— 白名单同时决定运行期加载与打包体积。
 * 2. **不挂 cadPlugin**：它的 `@mlightcad/*` 是可选 peer 依赖，本仓库未安装，挂上会在打开 dwg 时报错。
 * 3. **源用 profer-file://**：与 OfficePreview 同一条数据源（主进程 token 化的本地 URL），
 *    不把绝对路径带进渲染进程；OFV 接受 string 源并自行 fetch（该 scheme 已声明 secure + supportFetchAPI）。
 * 4. **必须显式传 fileName**：profer-file URL 没有扩展名，OFV 靠 `fileName` 选插件。
 *
 * 工具栏：与独立 viewer 页共用 `@/lib/ofv-toolbar` 的配置（去打印/搜索、加「用默认应用打开」）。
 * 本组件是**回退路径**（历史预览 tab、拖入组合等），文件面主路径已在浏览器列的 viewer 页。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import { createViewer, type FileViewer } from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import type { FileAccessOptions } from '@profer/shared'
import { createOfvPlugins } from '@/lib/ofv-plugins'
import { createOfvToolbarOptions } from '@/lib/ofv-toolbar'
import '@/styles/ofv-profer-theme.css'
import { resolvedThemeAtom } from '@/atoms/theme'
import { cn } from '@/lib/utils'

export interface OfvPreviewProps {
  filePath: string
  access?: FileAccessOptions
  className?: string
}


type Status = 'loading' | 'ready' | 'error'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '文件预览失败'
}

export function OfvPreview({ filePath, access, className }: OfvPreviewProps): React.ReactElement {
  const theme = useAtomValue(resolvedThemeAtom)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [status, setStatus] = React.useState<Status>('loading')
  const [error, setError] = React.useState('')
  const [retryVersion, setRetryVersion] = React.useState(0)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let viewer: FileViewer | null = null
    setStatus('loading')
    setError('')

    void (async () => {
      try {
        const resolved = await window.electronAPI.resolveFilePath(filePath, access)
        if (cancelled) return
        if (!resolved?.url) throw new Error('无法读取该文件（不在已授权目录内或文件不存在）')
        viewer = createViewer({
          container,
          file: resolved.url,
          fileName: filePath,
          plugins: createOfvPlugins(),
          theme,
          locale: 'zh-CN',
          toolbar: createOfvToolbarOptions({
            // 预览面已有 Profer 文件头（默认应用/所在位置），OFV 只保留文档级操作。
            showDefaultAppAction: false,
            // 这条路径有 preload：保留处理器以兼容未来显式调用，但不在 OFV 工具栏重复展示。
            onOpenInDefaultApp: () => {
              void window.electronAPI.systemOpenFile(filePath, undefined, access)
            },
          }),
          onLoad: () => {
            if (!cancelled) setStatus('ready')
          },
          onError: (viewerError) => {
            if (cancelled) return
            setError(errorMessage(viewerError))
            setStatus('error')
          },
        })
        if (cancelled) {
          viewer.destroy()
          viewer = null
        }
      } catch (caught: unknown) {
        if (cancelled) return
        setError(errorMessage(caught))
        setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      // 卸载时必须销毁：OFV 会在容器里挂 canvas / video / WebGL 上下文与 worker
      viewer?.destroy()
    }
  }, [access, filePath, retryVersion, theme])

  return (
    <div className={cn('relative h-full w-full min-h-0', className)}>
      <div ref={containerRef} className="h-full w-full" />

      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            正在解析文件…
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center px-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-xs text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={() => setRetryVersion((previous) => previous + 1)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-foreground/[0.04]"
            >
              <RotateCcw className="size-3" aria-hidden="true" />
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
