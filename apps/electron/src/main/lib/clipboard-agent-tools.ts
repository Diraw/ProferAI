/**
 * Agent 剪贴板写入工具的主进程实现，底层使用 Electron `clipboard`。
 * 剪贴板读取仅供应用自身交互使用，不向 Agent 暴露。
 */

import { clipboard } from 'electron'

/** 单次读/写剪贴板的字符上限，防止超大内容影响输出与内存。 */
export const MAX_CLIPBOARD_TEXT_CHARS = 64_000

export class ClipboardAgentToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClipboardAgentToolError'
  }
}

/** 带上限的读剪贴板文本；空剪贴板抛错，避免 Agent 误以为读到空字符串。 */
export function readClipboardText(): { text: string; truncated: boolean; totalChars: number } {
  const text = clipboard.readText()
  if (!text) throw new ClipboardAgentToolError('系统剪贴板当前没有文本。')
  const totalChars = Array.from(text).length
  if (totalChars > MAX_CLIPBOARD_TEXT_CHARS) {
    const truncated = Array.from(text).slice(0, MAX_CLIPBOARD_TEXT_CHARS).join('')
    return { text: truncated, truncated: true, totalChars }
  }
  return { text, truncated: false, totalChars }
}

/** 带上限的写剪贴板文本；空输入或超长抛错。 */
export function writeClipboardText(text: string): { writtenChars: number } {
  if (!text) throw new ClipboardAgentToolError('要写入剪贴板的文本不能为空。')
  const charCount = Array.from(text).length
  if (charCount > MAX_CLIPBOARD_TEXT_CHARS) {
    throw new ClipboardAgentToolError(`文本超过 ${MAX_CLIPBOARD_TEXT_CHARS} 个字符上限，请先精简后再写入剪贴板。`)
  }
  clipboard.writeText(text)
  return { writtenChars: charCount }
}
