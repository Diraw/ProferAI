import type { AgentRuntime } from '@profer/shared'
import type { AppSettings } from '../../types'

export interface AgentSystemPromptPolicy {
  useClaudeCodePreset: boolean
}

export type AgentRuntimeSystemPrompt = string | {
  type: 'preset'
  preset: 'claude_code'
  append: string
}

/** 根据本轮运行时生成最终 system prompt 形态。 */
export function resolveAgentSystemPromptPolicy(_settings: Pick<AppSettings, 'developerModeEnabled'>): AgentSystemPromptPolicy {
  return { useClaudeCodePreset: true }
}

/** 根据 runtime 与本轮冻结的策略生成最终 system prompt 形态。 */
export function resolveAgentRuntimeSystemPrompt(
  runtime: AgentRuntime,
  policy: AgentSystemPromptPolicy,
  systemPrompt: string,
): AgentRuntimeSystemPrompt {
  if (runtime === 'pi' || !policy.useClaudeCodePreset) return systemPrompt
  return {
    type: 'preset',
    preset: 'claude_code',
    append: systemPrompt,
  }
}
