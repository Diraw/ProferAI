import * as React from 'react'
import { useSetAtom } from 'jotai'

import { quotedSelectionsMapAtom, type QuotedSelection } from '@/atoms/preview-atoms'

/**
 * 浏览器列里的划词引用。
 *
 * 选区发生在**另一个 webContents**（受管浏览器视图里那个无 preload 的 viewer 页），
 * 本进程读不到它的 `getSelection()`；页面只能把文本经哨兵 URL 回投给主进程，
 * 主进程再转成 `BROWSER_LOCAL_FILE_SELECTION` 事件送到这里。
 *
 * 本 hook 只负责把事件写进 `quotedSelectionsMapAtom` —— 与预览面板的
 * `usePreviewQuotedSelection` 落在同一个 atom、同一套字段上，因此输入框里的引用胶囊、
 * 随消息发送的引用内容都不需要为「文件面在浏览器列」这件事做任何分支。
 *
 * 多引用语义：划词是**自动**产生的引用，始终只保留最新一条（`origin: 'browser-selection'`），
 * 不顶掉用户手动累积的引用；选区清空时只撤掉这条自动引用。
 */
/**
 * 纯函数形式的入库逻辑：空串删除自动引用、内容未变则原样返回（避免无谓重渲染）。
 * 抽出来是为了能直接单测「撤引用 / 去重 / 换文件」这三种边界。
 */
export function reduceBrowserFileSelection(
  previous: Map<string, QuotedSelection[]>,
  event: { sessionId: string; text: string; filePath: string; fileName: string },
): Map<string, QuotedSelection[]> {
  const list = previous.get(event.sessionId) ?? []
  const manualItems = list.filter((item) => item.origin !== 'browser-selection')
  const autoItem = list.find((item) => item.origin === 'browser-selection')

  // 空串 = 选区被清空（用户点了别处），只撤掉自动引用那条
  if (!event.text) {
    if (!autoItem) return previous
    const next = new Map(previous)
    if (manualItems.length === 0) next.delete(event.sessionId)
    else next.set(event.sessionId, manualItems)
    return next
  }

  if (autoItem?.text === event.text && autoItem.filePath === event.filePath) return previous

  const next = new Map(previous)
  next.set(event.sessionId, [
    ...manualItems,
    {
      text: event.text,
      filePath: event.filePath,
      sourceType: 'file',
      sourceLabel: event.fileName,
      capturedAt: Date.now(),
      origin: 'browser-selection',
    },
  ])
  return next
}

export function useBrowserLocalFileSelectionQuote(): void {
  const setQuotedSelectionsMap = useSetAtom(quotedSelectionsMapAtom)

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>)
      .onAgentBrowserLocalFileSelection
    if (!subscribe) return
    return subscribe((event) => {
      setQuotedSelectionsMap((previous) => reduceBrowserFileSelection(previous, event))
    })
  }, [setQuotedSelectionsMap])
}
