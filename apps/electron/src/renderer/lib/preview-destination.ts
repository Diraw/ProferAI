/**
 * 「文件点开去哪儿」的单一判定（纯函数，供 preview-opener 路由 + 单测共用）。
 *
 * 三个目的地：
 * - `ofv-viewer`：Open File Viewer 承担的长尾格式（老式 Office / 归档 / 设计文件 / 3D / GIS / 媒体 / 字体…）
 *   → 浏览器列里的**独立 viewer 页**（沙箱 webContents、无 preload）；
 * - `browser-inline`：文本 / 代码兜底 + 静态图 → **浏览器列里的 app 渲染器**（列内模式，
 *   复用预览面板那套渲染器，不经过 OFV）。无扩展名的文本文件（`Makefile` / `.gitignore`）也走这里；
 * - `panel`：其余留在预览面板 —— 各有专属渲染器或 Agent 契约（见下）。
 *
 * 为什么集中在这里：此前「去哪」散落在 `preview-opener` 的分支与 `DiffTabContent` 的扩展名判定里，
 * 两处各持一半事实。路由必须能被单测逐格式钉住，否则改一处就会静默错位。
 *
 * 覆盖面：`OFV_EXTS` 已经把「非文本」的长尾（媒体/字体/数据库/设计文件…）与「连 OFV 也做不了的
 * 二进制」分干净了 —— 前者进 viewer 页，后者走 `NON_PREVIEWABLE_BINARY_EXTS` 的「不支持预览」。
 * 所以这里剩下的默认分支就是文本/代码，不需要再维护一份「哪些扩展名是文本」的正向清单。
 */
import { fileExtension, isOfvBackedPath } from './ofv-extensions'
import { NON_PREVIEWABLE_BINARY_EXTS, PANEL_ONLY_PREVIEW_EXTS } from './preview-extension-sets'

export type PreviewDestination = 'ofv-viewer' | 'browser-inline' | 'panel'

export function resolvePreviewDestination(filePath: string): PreviewDestination {
  // OFV 优先：它的格式清单已把「连 OFV 也做不了」的纯二进制排除在外
  if (isOfvBackedPath(filePath)) return 'ofv-viewer'
  const extension = fileExtension(filePath)
  // 面板会给出「不支持预览此文件类型 + 扩展名」的准话，比丢给文本渲染器更诚实
  if (NON_PREVIEWABLE_BINARY_EXTS.has(extension)) return 'panel'
  if (PANEL_ONLY_PREVIEW_EXTS.has(extension)) return 'panel'
  return 'browser-inline'
}
