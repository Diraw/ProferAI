import type { BrowserViewState } from '@profer/shared'

/**
 * 明确的本机/局域网开发地址：本机回环、私有网段和 `.local` 主机名。
 * 这些地址在地址栏和起始页都必须默认按 HTTP 处理，否则 `192.168.1.10:8080`
 * 会被当成搜索词跳到 Bing，或补成无法连接的 HTTPS。
 */
const LOCAL_OR_PRIVATE_HOST = /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local)(?::\d{1,5})?(?:[/?#]|$)/i

/**
 * 起始页输入归一化：区分「本地开发地址」「公网域名」「搜索词」。
 * 与主进程 browser-policy 的协议默认规则保持一致，避免地址栏能打开、起始页却当搜索词。
 */
export function normalizeStartPageInput(input: string): string {
  const value = input.trim()
  if (!value) return ''
  // 1. 已带协议：直接当作完整 URL。
  if (/^https?:\/\//i.test(value)) return value
  // 2. 本地开发服务器：缺省协议按 HTTP。
  if (LOCAL_OR_PRIVATE_HOST.test(value)) return `http://${value}`
  // 3. 形如公网域名（含 "." 且无空格）：补 https://。
  //    允许带路径、端口、查询，避免把 "bilibili.com/" 误判为搜索词。
  if (!/\s/.test(value) && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(value)) return `https://${value}`
  // 4. 其余（裸词、含空格、中文等）当作搜索词。
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`
}

/**
 * 默认首页只能导航主进程已经创建的真实空标签。
 *
 * BrowserPanel 在收起时仍会预挂载以维持分栏动画；此时 `state` 为 null 表示
 * 当前会话从未打开过浏览器。若把它误判为空标签并调用 navigate，会反向创建
 * 浏览器会话，导致新会话一出现就自动弹出浏览器，且关闭最后一个标签后再次复活。
 */
export function shouldNavigateDefaultHome(
  state: BrowserViewState | null,
  defaultHomeUrl: string | null,
  lastAutoNavigatedTabId: string | null,
): boolean {
  if (!state || !defaultHomeUrl || state.url) return false
  return state.activeTabId.length > 0 && state.activeTabId !== lastAutoNavigatedTabId
}
