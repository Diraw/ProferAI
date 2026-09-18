import * as React from 'react'
import { useAtomValue } from 'jotai'

import { activeSkinIdAtom, resolvedThemeAtom, skinCssAppliedRevisionAtom, whenSkinCssApplied } from '@/atoms/theme'
import { readOfvThemeTokens } from '@/lib/ofv-theme-tokens'

/**
 * 把当前主题同步给浏览器列里的**本地文件预览**（viewer 页）。
 *
 * 为什么需要显式同步：viewer 页跑在受管浏览器的沙箱 webContents 里（无 preload），
 * 主题只能在打开时烘进 URL；那一页自己也读不到 app 的皮肤设置（`prefers-color-scheme`
 * 反映的是 OS，不是 app 里选的 light/dark/皮肤）。所以由渲染进程在主题**真正变化**时
 * 通知主进程按新主题重载那些预览。
 *
 * 只作用于本地预览标签：受管浏览器里的普通网页有自己的配色，永远不跟随 app 皮肤。
 *
 * 送过去的是 **theme + tokens**：
 * - `theme` 决定 OFV 自己的明暗类与页面 `color-scheme`；
 * - `tokens` 是 app 文档上实际生效的 token 值 —— 皮肤（含用户自定义皮肤）的配色靠它到达预览页，
 *   两个深色皮肤互相切换也能判出差异（只看明暗会漏）。
 * 主进程还会记住这份主题，供 Agent 打开的预览使用（那条路径没有渲染进程上下文）。
 *
 * 挂载时也会同步一次：让主进程一开始就拿到当前主题，而不是等到用户第一次换肤。
 * 依赖里还有 `skinCssAppliedRevisionAtom`：启动时皮肤 CSS 是异步注入的，
 * 注入落地后要再同步一次（否则会把基础主题的 token 当成皮肤配色送出去）。
 */
export function useBrowserPreviewThemeSync(): void {
  const theme = useAtomValue(resolvedThemeAtom)
  const skinId = useAtomValue(activeSkinIdAtom)
  const skinCssRevision = useAtomValue(skinCssAppliedRevisionAtom)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      // 皮肤 CSS 是异步 IPC 注入的，换肤那一帧读计算值仍是上一个皮肤的颜色 —— 先等它落定。
      await whenSkinCssApplied(skinId)
      // 等待期间主题又变了：这一轮的取值已过期，交给新的那一轮
      if (cancelled) return
      const sync = (window.electronAPI as Partial<typeof window.electronAPI>)
        .refreshBrowserPreviewTheme
      if (!sync) return
      try {
        await sync({ theme, tokens: readOfvThemeTokens() })
      } catch (error) {
        console.error('[preview] 同步本地预览主题失败:', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [theme, skinId, skinCssRevision])
}
