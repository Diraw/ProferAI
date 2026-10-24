import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import {
  THINKING_LEVEL_TITLES,
  EFFORT_TITLES,
  REASONING_DESCRIPTIONS,
} from './AgentReasoningSlider'
import type { AgentThinkingLevel, AgentEffort } from '@profer/shared'

describe('AgentReasoningSlider 核心常量与描述映射', () => {
  test('各推理强度档位标题存在且有中文语义', () => {
    const thinkingLevels: AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    for (const lvl of thinkingLevels) {
      expect(THINKING_LEVEL_TITLES[lvl]).toBeDefined()
      expect(typeof THINKING_LEVEL_TITLES[lvl]).toBe('string')
      expect(REASONING_DESCRIPTIONS[lvl]).toBeDefined()
    }

    const claudeEfforts: AgentEffort[] = ['low', 'medium', 'high', 'max']
    for (const eff of claudeEfforts) {
      expect(EFFORT_TITLES[eff]).toBeDefined()
      expect(typeof EFFORT_TITLES[eff]).toBe('string')
    }
  })

  test('最高算力与极简算力的场景描述差异明显', () => {
    expect(REASONING_DESCRIPTIONS['off']).toContain('不生成思考')
    expect(REASONING_DESCRIPTIONS['high']).toContain('推荐')
    expect(REASONING_DESCRIPTIONS['max']).toContain('极限')
  })
})
