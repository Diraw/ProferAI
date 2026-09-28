/**
 * 工具结果折叠预览的纯逻辑
 *
 * 折叠判定与预览切片必须出自同一次计算：判定按字符数、切片按行数时，
 * 「超长但行数很少」的内容（minified JSON、单行 PowerShell、heredoc）
 * 会被判定为需要折叠，切片却返回全文，等于没有折叠。
 *
 * 这里让预览同时受两个维度约束：
 * - 任一维度超限即折叠
 * - 折叠后先取前 previewLines 行，再按 maxChars 封顶
 */

export interface ResultPreviewOptions {
  /** 字符数上界：超过即折叠，折叠后预览也不会超过它 */
  maxChars: number
  /** 行数上界：超过即折叠，折叠后预览只取前 N 行 */
  previewLines: number
}

export interface ResultPreview {
  /** 用于渲染的文本：未折叠时是原文，折叠时是预览片段 */
  text: string
  /** 是否需要折叠（折叠按钮出现，且 text 只是片段） */
  collapsed: boolean
}

/** 是否为 UTF-16 高位代理（0xD800-0xDBFF） */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * 计算工具结果的预览片段。
 *
 * 切行统一按 `\r?\n`，折叠后的预览再以 `\n` 连接：Windows 输出的 CRLF 不会在
 * 预览里残留 `\r`（`whitespace-pre-wrap` 下 `\r` 也被当作换行，会多出空行）。
 */
export function sliceResultPreview(
  content: string,
  options: ResultPreviewOptions,
): ResultPreview {
  const safeContent = content ?? ''
  const maxChars = Math.max(0, options.maxChars)

  const lines = safeContent.split(/\r?\n/)
  const collapsed = safeContent.length > maxChars || lines.length > options.previewLines
  if (!collapsed) return { text: safeContent, collapsed }

  const head = lines.slice(0, options.previewLines).join('\n')
  if (head.length <= maxChars) return { text: head, collapsed }

  // 按字符封顶时不要切断代理对，否则孤立代理会渲染成 U+FFFD
  const end = isHighSurrogate(head.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars
  return { text: head.slice(0, end), collapsed }
}
