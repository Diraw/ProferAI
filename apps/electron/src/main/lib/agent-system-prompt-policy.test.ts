import { describe, expect, test } from 'bun:test'
import { resolveAgentRuntimeSystemPrompt, resolveAgentSystemPromptPolicy } from './agent-system-prompt-policy'

describe('resolveAgentSystemPromptPolicy', () => {
  test('标准模式始终保留 Claude Code preset 策略', () => {
    const settings = { developerModeEnabled: false }
    expect(resolveAgentSystemPromptPolicy(settings)).toEqual({ useClaudeCodePreset: true })
  })

  test('Claude 标准模式追加原生 preset，Pi 使用自身字符串协议', () => {
    const policy = resolveAgentSystemPromptPolicy({ developerModeEnabled: false })
    expect(resolveAgentRuntimeSystemPrompt('claude', policy, 'PROMPT')).toEqual({
      type: 'preset', preset: 'claude_code', append: 'PROMPT',
    })
    expect(resolveAgentRuntimeSystemPrompt('pi', policy, 'PROMPT')).toBe('PROMPT')
  })

  test('轻量 Claude 提示词仍可显式不加载代码 preset', () => {
    expect(resolveAgentRuntimeSystemPrompt('claude', { useClaudeCodePreset: false }, 'LIGHT')).toBe('LIGHT')
  })
})
