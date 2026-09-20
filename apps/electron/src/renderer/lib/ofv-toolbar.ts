/**
 * OFV 工具栏配置（viewer 独立页与渲染进程内回退路径共用同一份，避免两处漂移）
 *
 * 取舍：
 * - **不要打印**：app 自己会处理"把这份文件打出来"的路径，viewer 里再放一个打印按钮只会
 *   触发浏览器打印对话框，和 app 的观感/行为都不一致；
 * - **不要搜索**：OFV 的搜索只对纯文本类格式（text/markdown/邮件正文）有意义，对归档、设计文件、
 *   模型、Office 这类格式要么无候选要么语义奇怪，留着反而是噪音；
 * - **要"用默认应用打开"**：预览是只读的，遇到需要编辑/深看的文件，正确的出口是交回用户的
 *   本地应用，而不是在 app 里造一套编辑器。
 *
 * 两个调用点的差异只在 `onOpenInDefaultApp`：
 * - 独立 viewer 页跑在无 preload 的沙箱 webContents 里，**没有 IPC**，因此把意图以哨兵 URL
 *   投给主进程（`browser-controller` 拦截后打开该标签自己的本地文件）；
 * - app 内回退路径有 preload，直接走 `systemOpenFile` IPC。
 */

import type { PreviewToolbarOptions } from '@open-file-viewer/core'
import { BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL } from '@profer/shared'

export interface OfvToolbarHandlers {
  /**
   * 用系统默认应用打开当前文件。
   * 不传时会回落到哨兵 URL —— 仅适用于无 preload 的独立 viewer 页。
   */
  onOpenInDefaultApp?: () => void
  /** 是否在 OFV 工具栏中显示“默认应用”。Profer 外层已有文件头时关闭，避免重复。 */
  showDefaultAppAction?: boolean
}

export function createOfvToolbarOptions(handlers: OfvToolbarHandlers = {}): PreviewToolbarOptions {
  const showDefaultAppAction = handlers.showDefaultAppAction ?? true
  return {
    // 注意：OFV 只有在 `toolbar === true` 时才给全套默认值；
    // 一旦传对象，未显式写 true 的开关就等于关闭（其 createToolbar 源码如此），
    // 所以缩放/旋转必须写出来，否则会被静默去掉。
    zoom: true,
    rotate: true,
    download: true,
    fullscreen: true,
    print: false,
    search: false,
    actions: showDefaultAppAction ? [
      {
        id: 'open-in-default-app',
        label: '默认应用',
        title: '用默认应用打开',
        order: 90,
        onClick: () => {
          if (handlers.onOpenInDefaultApp) {
            handlers.onOpenInDefaultApp()
            return
          }
          window.open(BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL, '_blank')
        },
      },
    ] : [],
  }
}
