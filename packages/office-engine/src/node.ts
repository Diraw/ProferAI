/**
 * @profer/office-engine/node — Node 侧运行时入口
 *
 * 双平面流式重排与空间拓扑 Office 文档解析引擎，支持 DOCX / PPTX / XLSX（含宏与模板变体）。
 *
 * - 平面 A（语义重排平面）：GDI 度量分行、2D 仿射变换拍平、动画因果序、Mermaid 图、
 *   LaTeX 公式、稀疏网格连接域切分。
 * - 平面 B（坐标规范化平面）：统一以 1 pt = 12,700 EMUs 归一化 `[x0, y0, x1, y1]`
 *   包围盒与 `p{page}-b{idx}` 拓扑锚点。
 *
 * 本入口依赖 Node 原生能力（node:zlib / node:path），**仅供 Electron 主进程与 CLI 使用**。
 * 渲染层请勿 import 本入口，否则 Vite 会把 node:zlib 打进浏览器 bundle；如需类型，
 * 用主入口 '@profer/office-engine'（仅类型，浏览器安全）。
 *
 * 来源：移植自 CDUT Studio `packages/core/src/office-engine`（@ c83c6a45）。
 */

import { OoxmlZipReader, detectOfficeFormatFromZip } from './ooxml-zip-reader'
import { solveDocxReflow } from './docx-reflow-solver'
import { solvePptxTopology } from './pptx-topology-solver'
import { solveXlsxGrid } from './xlsx-grid-solver'
import { serializeOfficeDocumentToMarkdown } from './office-serializer'
import type { OfficeFormat, OfficeDocumentLayoutAST, OfficeParseOptions, OfficeParseResult } from './types'

export * from './types'
export * from './ooxml-zip-reader'
export * from './docx-reflow-solver'
export * from './pptx-topology-solver'
export * from './xlsx-grid-solver'
export * from './office-serializer'

/**
 * 根据文件扩展名或路径推断 Office 格式
 */
export function inferOfficeFormatFromExtension(extOrPath?: string): OfficeFormat | undefined {
  if (!extOrPath) return undefined
  const lower = extOrPath.trim().toLowerCase()
  if (
    lower.endsWith('.docx') ||
    lower.endsWith('.docm') ||
    lower.endsWith('.dotx') ||
    lower.endsWith('.dotm') ||
    lower === 'docx'
  ) {
    return 'docx'
  }
  if (
    lower.endsWith('.pptx') ||
    lower.endsWith('.pptm') ||
    lower.endsWith('.potx') ||
    lower.endsWith('.potm') ||
    lower.endsWith('.ppsx') ||
    lower.endsWith('.ppsm') ||
    lower === 'pptx'
  ) {
    return 'pptx'
  }
  if (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    lower.endsWith('.xltx') ||
    lower.endsWith('.xltm') ||
    lower === 'xlsx'
  ) {
    return 'xlsx'
  }
  return undefined
}

/**
 * 解析 OOXML Office 文档二进制数据（DOCX / PPTX / XLSX），输出双平面 AST 与带锚点/纯文本 Markdown
 */
export function parseOfficeBuffer(
  buffer: Buffer | Uint8Array,
  formatOrHint?: OfficeFormat | string,
  options?: OfficeParseOptions,
): OfficeParseResult {
  const zip = new OoxmlZipReader(buffer)
  const fallbackFormat =
    formatOrHint === 'docx' || formatOrHint === 'pptx' || formatOrHint === 'xlsx'
      ? formatOrHint
      : inferOfficeFormatFromExtension(formatOrHint) ?? inferOfficeFormatFromExtension(options?.fileName)

  const detectedFormat = detectOfficeFormatFromZip(zip, fallbackFormat)

  let ast: OfficeDocumentLayoutAST
  switch (detectedFormat) {
    case 'docx':
      ast = solveDocxReflow(zip, options)
      break
    case 'pptx':
      ast = solvePptxTopology(zip, options)
      break
    case 'xlsx':
      ast = solveXlsxGrid(zip, options)
      break
  }

  const includeAnchors = options?.includeAnchors ?? true
  const anchoredMarkdown = serializeOfficeDocumentToMarkdown(ast, {
    includeAnchors: true,
    includePageHeaders: true,
  })
  const cleanMarkdown = serializeOfficeDocumentToMarkdown(ast, {
    includeAnchors: false,
    includePageHeaders: false,
  })

  return {
    format: detectedFormat,
    ast,
    markdown: includeAnchors ? anchoredMarkdown : cleanMarkdown,
    cleanMarkdown,
  }
}

/**
 * 异步兼容包装器：解析 Office 文档二进制数据
 */
export async function parseOfficeDocument(
  buffer: Buffer | Uint8Array,
  formatOrHint?: OfficeFormat | string,
  options?: OfficeParseOptions,
): Promise<OfficeParseResult> {
  return parseOfficeBuffer(buffer, formatOrHint, options)
}
