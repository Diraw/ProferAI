import type { QuotedSelection } from '@/atoms/preview-atoms'
import type { QuotedSelectionSourceType } from '@/atoms/preview-atoms'
import { getFileBaseName } from '@/lib/file-utils'

export interface ParsedQuotedSelectionRef {
  path: string
  filename: string
  sourceType: QuotedSelectionSourceType
  label?: string
}

export const SELECTION_ACTION_POPOVER_SELECTOR = '[data-selection-action-popover]'
export const SELECTION_ACTION_TARGET_SELECTOR = `${SELECTION_ACTION_POPOVER_SELECTOR}, [data-agent-toolbar-corridor]`

const QUOTED_FILE_REGEX = /<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g
const QUOTED_CONTEXT_REGEX = /<quoted_context[^>]*>[\s\S]*?<\/quoted_context>\n*/g

/** 兼容 Markdown/富文本转义出的引用标签，例如 \\<quoted\\_context ...\\>。 */
function normalizeEscapedQuotedTags(content: string): string {
  const quoteTag = /\\?<\\?\/?quoted\\?_?(file|context)\b[^>]*?\\?>/gi
  return content.replace(quoteTag, (tag) => tag.replaceAll('\\', ''))
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function sanitizeQuotedText(value: string): string {
  return value
    .replace(/<\/quoted_file>/gi, '</quoted_file_>')
    .replace(/<\/quoted_context>/gi, '</quoted_context_>')
}

export function buildQuotedSelectionBlock(quotedSelection: QuotedSelection): string {
  const safeText = sanitizeQuotedText(quotedSelection.text)

  if (quotedSelection.sourceType === 'visualization' && quotedSelection.visualization) {
    const quote = quotedSelection.visualization
    return `<quoted_context source="visualization" label="${escapeXmlAttribute(quotedSelection.sourceLabel ?? quote.label)}" visualization_id="${escapeXmlAttribute(quote.visualizationId)}" revision="${escapeXmlAttribute(quote.revision)}" object_id="${escapeXmlAttribute(quote.objectId)}">\n${safeText}\n</quoted_context>\n\n`
  }

  if (quotedSelection.sourceType && quotedSelection.sourceType !== 'file') {
    const safeSource = escapeXmlAttribute(quotedSelection.sourceType)
    const safeLabel = escapeXmlAttribute(quotedSelection.sourceLabel ?? quotedSelection.filePath)
    // 只写有值的属性：空 message_id/role 在多引用场景会成倍放噪。
    const messageAttr = quotedSelection.messageId
      ? ` message_id="${escapeXmlAttribute(quotedSelection.messageId)}"`
      : ''
    const roleAttr = quotedSelection.messageRole
      ? ` role="${escapeXmlAttribute(quotedSelection.messageRole)}"`
      : ''
    return `<quoted_context source="${safeSource}" label="${safeLabel}"${messageAttr}${roleAttr}>\n${safeText}\n</quoted_context>\n\n`
  }

  const safePath = escapeXmlAttribute(quotedSelection.filePath)
  // 行号只在能算出时写入，便于模型定位同一文件里的多段引用。
  const startLineAttr = typeof quotedSelection.startLine === 'number' ? ` start_line="${quotedSelection.startLine}"` : ''
  const endLineAttr = typeof quotedSelection.endLine === 'number' ? ` end_line="${quotedSelection.endLine}"` : ''
  return `<quoted_file path="${safePath}"${startLineAttr}${endLineAttr}>\n${safeText}\n</quoted_file>\n\n`
}

/** 引用去重键：来源类型 + 来源标识 + 选中文本。 */
export function getQuotedSelectionKey(quotedSelection: QuotedSelection): string {
  const source = quotedSelection.sourceType ?? 'file'
  const origin = source === 'file'
    ? quotedSelection.filePath
    : quotedSelection.messageId ?? quotedSelection.filePath
  return `${source}\u0000${origin}\u0000${quotedSelection.text}`
}

/** 追加一条引用；已存在同来源同文本时返回 duplicate=true 且列表不变。 */
export function appendQuotedSelection(
  list: readonly QuotedSelection[],
  quotedSelection: QuotedSelection,
): { list: QuotedSelection[]; duplicate: boolean } {
  const key = getQuotedSelectionKey(quotedSelection)
  if (list.some((item) => getQuotedSelectionKey(item) === key)) {
    return { list: [...list], duplicate: true }
  }
  return { list: [...list, quotedSelection], duplicate: false }
}

/** 多条引用按顺序拼成前缀块；顺序即用户在引用列表里看到的顺序。 */
export function buildQuotedSelectionsPrefix(list: readonly QuotedSelection[]): string {
  return list.map((item) => buildQuotedSelectionBlock(item)).join('')
}

function normalizeContextSourceType(value: string | undefined): QuotedSelectionSourceType {
  if (value === 'visualization') return 'visualization'
  if (value === 'scratch-pad') return 'scratch-pad'
  if (value === 'agent-interruption') return 'agent-interruption'
  return 'agent-history'
}

export function parseQuotedSelectionRefs(content: string): { quotes: ParsedQuotedSelectionRef[]; text: string } {
  const normalizedContent = normalizeEscapedQuotedTags(content)
  const quotes: ParsedQuotedSelectionRef[] = []

  let quoteMatch: RegExpExecArray | null
  QUOTED_FILE_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_FILE_REGEX.exec(normalizedContent)) !== null) {
    const pathMatch = quoteMatch[0].match(/path="([^"]*)"/)
    if (!pathMatch) continue
    const filePath = decodeXmlAttribute(pathMatch[1]!)
    quotes.push({
      path: filePath,
      filename: getFileBaseName(filePath),
      sourceType: 'file',
    })
  }

  QUOTED_CONTEXT_REGEX.lastIndex = 0
  while ((quoteMatch = QUOTED_CONTEXT_REGEX.exec(normalizedContent)) !== null) {
    const labelMatch = quoteMatch[0].match(/label="([^"]*)"/)
    const sourceMatch = quoteMatch[0].match(/source="([^"]*)"/)
    const label = labelMatch ? decodeXmlAttribute(labelMatch[1]!) : 'Agent 历史'
    const sourceType = normalizeContextSourceType(sourceMatch ? decodeXmlAttribute(sourceMatch[1]!) : 'agent-history')
    quotes.push({
      path: label,
      filename: label,
      sourceType,
      label,
    })
  }

  const text = normalizedContent
    .replace(QUOTED_FILE_REGEX, '')
    .replace(QUOTED_CONTEXT_REGEX, '')
    .trim()

  return { quotes, text }
}
