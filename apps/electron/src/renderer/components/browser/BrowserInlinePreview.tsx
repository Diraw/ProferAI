/**
 * BrowserInlinePreview — 浏览器列里的「列内文件预览」宿主。
 *
 * 定位：文本 / 代码兜底 + 静态图在浏览器列里的渲染位置。它**不是** viewer 页：
 * 不新开 webContents、不经过 OFV、不需要 preload —— 它只是 app 文档里的一个 DOM 浮层，
 * 复用预览面板那套 `DiffTabContent`（Pierre 代码视图 / 图片 / 目录列表）。
 *
 * 为什么能这么做：浏览器列的内容区本来就是 DOM（见 `BrowserViewport`），原生 `WebContentsView`
 * 只是**盖在它上面**。带上 `data-browser-blocking` 后，原生视图会自行让位
 * —— 与「页面加载失败」浮层用的是同一机制（`BrowserViewport.findBlockingOverlay`）。
 * 因此这里不需要任何新的布局协议，也不需要主进程知道「正在看文件」。
 *
 * 保留的能力（因为仍在同一个 app 文档里）：高亮、查找栏（Cmd+F）、划词 → 对话引用、
 * `.txt/.log` 编辑、外部修改后刷新、滚动位置。列地址行会同步显示「本地文件 · 只读/可编辑 + 文件名」。
 */

import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { ExternalLink, PanelBottomClose } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

import { DiffTabContent } from '@/components/diff/DiffTabContent'
import { resolvePreviewDirPath } from '@/components/diff/preview-open-path'
import { agentSessionPathMapAtom } from '@/atoms/agent-atoms'
import type { PreviewFile } from '@/atoms/preview-atoms'
import { cn } from '@/lib/utils'
import { closeBrowserInlinePreview, openPreviewTab } from '@/components/diff/preview-opener'

export interface BrowserInlinePreviewProps {
  sessionId: string
  file: PreviewFile
  className?: string
}

export function BrowserInlinePreview({ sessionId, file, className }: BrowserInlinePreviewProps): React.ReactElement {
  const sessionPath = useAtomValue(agentSessionPathMapAtom).get(sessionId) ?? ''
  const store = useStore()
  const dirPath = file.dirPath || sessionPath || resolvePreviewDirPath(file.filePath, sessionPath)
  const toolbarActions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              openPreviewTab(store, sessionId, file.filePath)
              closeBrowserInlinePreview(sessionId)
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/70"
            aria-label="在标签页中打开"
          >
            <ExternalLink className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom"><p>在标签页中打开（列较窄时更好读）</p></TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => closeBrowserInlinePreview(sessionId)}
            className="flex size-6 shrink-0 items-center justify-center rounded text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground/70"
            aria-label="关闭文件预览"
          >
            <PanelBottomClose className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom"><p>关闭文件预览（回到浏览器）</p></TooltipContent>
      </Tooltip>
    </>
  )

  return (
    <div
      // 原生 WebContentsView 在 DOM 之上；这个属性让它自行隐藏，否则文件预览会被网页盖住
      data-browser-blocking
      data-state="open"
      className={cn('absolute inset-0 z-20 flex flex-col overflow-hidden bg-content-area titlebar-no-drag', className)}
      role="region"
      aria-label={`文件预览：${file.filePath}`}
    >
      <DiffTabContent
        // 换文件换会话都重建：DiffTabContent 内部持有 content/scroll/编辑态，跨文件复用会串
        key={`${sessionId}:${file.filePath}`}
        filePath={file.filePath}
        dirPath={dirPath}
        sessionId={sessionId}
        previewOnly
        readOnly={file.readOnly}
        basePaths={file.basePaths}
        toolbarActions={toolbarActions}
      />
    </div>
  )
}
