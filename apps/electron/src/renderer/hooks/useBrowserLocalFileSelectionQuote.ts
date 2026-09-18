import * as React from 'react'
import { useSetAtom } from 'jotai'

import { quotedSelectionMapAtom, type QuotedSelection } from '@/atoms/preview-atoms'

/**
 * 浏览器列里的划词引用。
 *
 * 选区发生在**另一个 webContents**（受管浏览器视图里那个无 preload 的 viewer 页），
 * 本进程读不到它的 `getSelection()`；页面只能把文本经哨兵 URL 回投给主进程，
 * 主进程再转成 `BROWSER_LOCAL_FILE_SELECTION` 事件送到这里。
 *
 * 本 hook 只负责把事件写进 `quotedSelectionMapAtom` —— 与预览面板的
 * `usePreviewQuotedSelection` 落在同一个 atom、同一套字段上，因此输入框里的引用胶囊、
 * 随消息发送的引用内容都不需要为「文件面在浏览器列」这件事做任何分支。
 */
/**
 * 纯函数形式的入库逻辑：空串删除、内容未变则原样返回（避免无谓重渲染）。
 * 抽出来是为了能直接单测「撤引用 / 去重 / 换文件」这三种边界。
 */
export function reduceBrowserFileSelection(
  previous: Map<string, QuotedSelection>,
  event: { sessionId: string; text: string; filePath: string; fileName: string },
): Map<string, QuotedSelection> {
  // 空串 = 选区被清空（用户点了别处），撤掉引用胶囊
  if (!event.text) {
    if (!previous.has(event.sessionId)) return previous
    const next = new Map(previous)
    next.delete(event.sessionId)
    return next
  }
  const existing = previous.get(event.sessionId)
  if (existing?.text === event.text && existing.filePath === event.filePath) return previous
  const next = new Map(previous)
  next.set(event.sessionId, {
    text: event.text,
    filePath: event.filePath,
    sourceType: 'file',
    sourceLabel: event.fileName,
    capturedAt: Date.now(),
  })
  return next
}

export function useBrowserLocalFileSelectionQuote(): void {
  const setQuotedSelectionMap = useSetAtom(quotedSelectionMapAtom)

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>)
      .onAgentBrowserLocalFileSelection
    if (!subscribe) return
    return subscribe((event) => {
      setQuotedSelectionMap((previous) => reduceBrowserFileSelection(previous, event))
    })
  }, [setQuotedSelectionMap])
}
