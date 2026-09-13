import { z } from 'zod'
import { dialog } from 'electron'
import { basename, extname } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import type { ProferPluginTaskContext, ProferPluginTaskReference } from '@profer/plugin-api'
import { getMainWindow } from '../main-window-state'
import { getConversationBranch } from '../conversation-manager'
import { getAgentSessionSDKMessages } from '../agent-session-manager'
import { extractTextFromAttachment } from '../document-parser'

export function readPluginTaskContext(reference: ProferPluginTaskReference | null): ProferPluginTaskContext | null {
  if (!reference) return null
  let messages: ProferPluginTaskContext['messages']
  if (reference.kind === 'chat') {
    messages = getConversationBranch(reference.sessionId).map((message) => ({ id: message.id, role: message.role, text: message.content }))
  } else {
    const page = getAgentSessionSDKMessages(reference.sessionId, { tail: 100 })
    messages = page.messages.flatMap((message) => {
      if (message.type !== 'user' && message.type !== 'assistant') return []
      const parsed = z.object({ uuid: z.string(), message: z.object({ content: z.union([
        z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]) }) }).safeParse(message)
      if (!parsed.success) return []
      const content = parsed.data.message.content
      const text = typeof content === 'string' ? content : content.flatMap((block) => block.type === 'text' && block.text ? [block.text] : []).join('\n')
      return [{ id: parsed.data.uuid, role: message.type, text }]
    })
  }
  if (reference.messageId) messages = messages.filter((message) => message.id === reference.messageId)
  // 选择文字时只传选中内容；不隐式附带整段会话。
  if (reference.selection) messages = []
  let remaining = 100_000
  messages = messages.slice(-100).reverse().map((message) => {
    const text = message.text.slice(-Math.max(0, remaining))
    const limited = remaining > 0 ? text : ''
    remaining -= limited.length
    return { ...message, text: limited }
  }).reverse().filter((message) => message.text)
  return { kind: reference.kind, sessionId: reference.sessionId, ...(reference.selection && { selection: reference.selection }), messages }
}
export async function selectPluginAttachments(): Promise<Array<{ name: string; text: string }>> {
  const owner = getMainWindow()
  if (!owner) throw new Error('主窗口未就绪')
  const result = await dialog.showOpenDialog(owner, {
    title: '选择交给插件读取的附件', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '文档和文本', extensions: ['txt', 'md', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'pptx'] }],
  })
  if (result.canceled) return []
  if (result.filePaths.length > 5) throw new Error('每次最多选择 5 个附件')
  const files: Array<{ name: string; text: string }> = []
  let total = 0
  for (const path of result.filePaths) {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('附件必须是 8 MB 以内的普通文件')
    const text = ['.txt', '.md', '.csv', '.json'].includes(extname(path).toLowerCase())
      ? readFileSync(path, 'utf8') : await extractTextFromAttachment(path)
    total += text.length
    if (total > 500_000) throw new Error('附件文本总量超过 50 万字符')
    files.push({ name: basename(path), text })
  }
  return files
}
