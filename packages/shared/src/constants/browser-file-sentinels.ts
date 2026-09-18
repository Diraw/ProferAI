/**
 * viewer 页 → 主进程的「意图回投」哨兵。
 *
 * 背景：浏览器列里的文件预览跑在**无 preload** 的沙箱 webContents（受管浏览器视图）里，
 * 那一页拿不到任何 Electron 能力 / IPC。它需要两种把用户意图交回 app 的能力：
 *
 * 1. 用系统默认应用打开当前文件（预览只读，需要编辑时正确的出口是交回本地应用）；
 * 2. 把用户圈选的文字交给 app，变成对话里的引用（与预览面板的划词引用同一套语义）。
 *
 * 两者都只能借「开窗 / 导航」这条唯一出口：页面打开一个只有主进程认识的伪协议 URL，
 * 主进程在 `setWindowOpenHandler` / `will-navigate` 里拦下它并拒绝真正导航。
 *
 * 安全性：主进程**只认这里定义的常量**，且回投内容只作用于「该标签自己的本地文件」
 * —— 页面无法借哨兵打开任意路径，也无法伪造其它标签的选区。
 */

/** 用系统默认应用打开当前预览文件。 */
export const BROWSER_LOCAL_FILE_OPEN_DEFAULT_URL = 'profer-action://open-in-default-app'

/** 回投划词：`profer-selection://<encodeURIComponent(text)>`；空串表示选区被清空。 */
export const BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX = 'profer-selection://'

/**
 * 划词引用的字符上限，与渲染进程 `usePreviewQuotedSelection` 的 MAX_QUOTED_CHARS 同值。
 * 两侧同值是有意的：页面侧截断避免超长 URL，主进程侧再截断一次作为边界兜底。
 */
export const BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS = 2000

/** 页面侧：把选中文本编码成哨兵 URL（超限先截断）。 */
export function encodeBrowserLocalFileSelection(text: string): string {
  const clipped =
    text.length > BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS
      ? text.slice(0, BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS)
      : text
  return `${BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX}${encodeURIComponent(clipped)}`
}

/**
 * 主进程侧：解析哨兵 URL。非本协议或百分号编码畸形（页面可能塞进坏数据）都返回 null，
 * 调用方据此忽略该次回投。
 */
export function parseBrowserLocalFileSelection(url: string): string | null {
  if (!url.startsWith(BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX)) return null
  const encoded = url.slice(BROWSER_LOCAL_FILE_SELECTION_URL_PREFIX.length)
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  return decoded.length > BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS
    ? decoded.slice(0, BROWSER_LOCAL_FILE_SELECTION_MAX_CHARS)
    : decoded
}
