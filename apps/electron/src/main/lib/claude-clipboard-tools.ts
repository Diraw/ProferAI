import { writeClipboardText } from './clipboard-agent-tools'

type ZodModule = typeof import('zod')
type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

/**
 * Claude runtime 的剪贴板写入 MCP 桥接。
 */
export async function injectClaudeClipboardMcpServer(
  sdk: ClaudeSdk,
  mcpServers: Record<string, Record<string, unknown>>,
  disabledTools?: string[],
): Promise<void> {
  let z: ZodModule['z']
  try { ({ z } = await import('zod') as ZodModule) } catch { z = require('zod').z }

  const server = sdk.createSdkMcpServer({
    name: 'clipboard',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'clipboard_write_text',
        '写入文本到系统剪贴板。需要把文本放到剪贴板供之后手动粘贴时使用本工具；写入前请确认文本不含不应泄露到剪贴板的敏感信息。',
        { text: z.string().min(1).describe('要写入系统剪贴板的完整文本。') },
        async ({ text }) => {
          try {
            const { writtenChars } = writeClipboardText(text)
            return textResult({ writtenChars, message: `已写入 ${writtenChars} 个字符到系统剪贴板。` })
          } catch (error) {
            return textResult({ error: error instanceof Error ? error.message : '写入剪贴板失败。' })
          }
        },
      ),
    ].filter((tool) => !disabledTools?.includes(tool.name)),
  })
  mcpServers.clipboard = server as unknown as Record<string, unknown>
}
