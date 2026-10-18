import { sendAgentLocalImage, type AgentImageOutputContext } from './agent-image-output-service'
import { filterDisabledTools } from '@profer/shared'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details?: unknown }

function result(payload: Awaited<ReturnType<typeof sendAgentLocalImage>>): ToolResult {
  return {
    content: [{
      text: `图片已复制到当前会话并自动附加到回复。相对路径：${payload.image.relativePath}。`,
      type: 'text',
    }],
    // 结构化 details 由 Profer UI 直接消费；不再要求模型回显 marker。
    details: payload,
  }
}

/** Claude runtime 的受控本地图片输出 MCP 工具。 */
export async function injectAgentImageOutputMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  context: AgentImageOutputContext,
  disabledTools?: string[],
): Promise<void> {
  let z: typeof import('zod').z
  try { ({ z } = await import('zod')) } catch { z = require('zod').z }

  const server = sdk.createSdkMcpServer({
    name: 'agent-image-output',
    version: '1.0.0',
    tools: filterDisabledTools([
      sdk.tool(
        'send_local_image',
        'Send an existing local PNG/JPEG/GIF/WebP into the final reply. Relative paths resolve from the session cwd; absolute paths must be inside the session cwd or an authorized attached directory. Profer attaches the verified image automatically. Does not generate or edit images.',
        {
          path: z.string().min(1).max(4096),
        },
        async (args) => result(await sendAgentLocalImage(args, context)),
      ),
    ], disabledTools),
  })
  mcpServers['agent-image-output'] = server as unknown as Record<string, unknown>
}

/** Pi 与 Claude 共用相同的结构化图片工具结果。 */
export function formatAgentImageOutputToolResult(payload: Awaited<ReturnType<typeof sendAgentLocalImage>>): ToolResult {
  return result(payload)
}
