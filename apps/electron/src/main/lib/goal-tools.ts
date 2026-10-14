import { GOAL_UPDATE_TOOL_NAME } from '@profer/shared'
import type { AgentGoalIterationResult } from '@profer/shared'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')
type ZodModule = typeof import('zod')

export interface GoalToolsContext {
  iteration: number
  report: (result: AgentGoalIterationResult) => void
}

function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function normalizeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 20)
}

export function normalizeGoalToolResult(input: { status: unknown; summary: unknown; evidence: unknown }): AgentGoalIterationResult {
  const status = input.status === 'complete' || input.status === 'blocked' ? input.status : 'continue'
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  const evidence = normalizeEvidence(input.evidence)
  const validStatus = input.status === 'continue' || input.status === 'complete' || input.status === 'blocked'
  if (!validStatus || summary.length === 0 || input.status === 'complete' && evidence.length === 0) {
    return { status: 'continue', summary, evidence, outcome: 'failed', error: 'Goal 报告格式无效或缺少真实证据' }
  }
  return { status, summary, evidence, outcome: 'success' }
}

export function normalizeGoalIterationResult(input: AgentGoalIterationResult): AgentGoalIterationResult {
  return normalizeGoalToolResult(input)
}

/** Claude runtime 的 Goal 内部状态工具。结果只回传给 GoalController，不写入普通对话。 */
export async function injectGoalMcpServer(
  sdk: ClaudeSdk,
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: GoalToolsContext,
): Promise<void> {
  let z: ZodModule['z']
  try { ({ z } = await import('zod') as ZodModule) } catch { z = require('zod').z }
  const server = sdk.createSdkMcpServer({
    name: 'goal',
    version: '1.0.0',
    tools: [
      sdk.tool(
        GOAL_UPDATE_TOOL_NAME,
        'Report the current Goal turn result to the host. This is an internal control tool, not a user-facing message. Use status complete only with real evidence; use blocked only when user input or an external state change is required.',
        {
          status: z.enum(['continue', 'complete', 'blocked']),
          summary: z.string().min(1).max(2000),
          evidence: z.array(z.string().min(1).max(1000)).max(20),
        },
        async ({ status, summary, evidence }) => {
          const result = normalizeGoalToolResult({ status, summary, evidence })
          ctx.report(result)
          return jsonResult({ accepted: true, iteration: ctx.iteration, status: result.status })
        },
      ),
    ],
  })
  mcpServers.goal = server as unknown as Record<string, unknown>
}
