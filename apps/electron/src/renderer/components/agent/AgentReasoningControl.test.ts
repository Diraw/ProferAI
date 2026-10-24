import { describe, expect, test } from 'bun:test'
import type { ReasoningCapability } from '@profer/shared'
import {
  DEFAULT_REASONING_OPTION,
  resolveReasoningChipState,
  resolveReasoningOptions,
  THINKING_LEVEL_LABELS,
} from './AgentReasoningControl'

const deepseek: ReasoningCapability = {
  source: 'profile',
  levels: ['off', 'low', 'high', 'xhigh', 'max'],
  defaultLevel: 'high',
  effortMap: { low: 'high', high: 'high', xhigh: 'max', max: 'max' },
}

const glm: ReasoningCapability = {
  source: 'profile',
  levels: ['off', 'high'],
  defaultLevel: 'high',
}

describe('resolveReasoningChipState', () => {
  test('会话覆盖优先于预设，且标记为覆盖来源', () => {
    expect(resolveReasoningChipState({ capability: deepseek, sessionLevel: 'max', presetEffort: 'low' }))
      .toEqual({ label: '最高', muted: false, sourceText: '本会话覆盖' })
  })

  test('无会话覆盖时用预设档位，并按模型 capability 收敛', () => {
    // GLM-5.3 只有 关闭/高，预设的 max 必须收敛到高，不能让 chip 显示一个不可选的档。
    expect(resolveReasoningChipState({ capability: glm, presetEffort: 'max' }))
      .toEqual({ label: '高', muted: true, sourceText: '跟随预设「高」' })
  })

  test('没有 capability 时按 adaptive + 强度档展示，关闭时显示关闭', () => {
    expect(resolveReasoningChipState({ agentThinking: { type: 'adaptive' }, presetEffort: 'low' }))
      .toEqual({ label: '低', muted: true, sourceText: '跟随预设「低」' })
    expect(resolveReasoningChipState({ agentThinking: { type: 'disabled' } }))
      .toEqual({ label: '关闭', muted: true, sourceText: '思考已关闭' })
  })

  test('会话级强度覆盖后标记为覆盖来源', () => {
    expect(resolveReasoningChipState({ agentThinking: { type: 'adaptive' }, sessionEffort: 'max', presetEffort: 'low' }))
      .toEqual({ label: '最大', muted: false, sourceText: '本会话覆盖' })
  })

  test('会话档位来自上一个模型时按新 capability 收敛，但仍算覆盖', () => {
    // DeepSeek 选了 max 后切到 GLM-5.3：只能显示高。
    expect(resolveReasoningChipState({ capability: glm, sessionLevel: 'max' }))
      .toEqual({ label: '高', muted: false, sourceText: '本会话覆盖' })
  })

  test('xhigh 与 max 文案必须可区分，避免「最高/最大」并排时无法理解', () => {
    expect(THINKING_LEVEL_LABELS.xhigh).not.toBe(THINKING_LEVEL_LABELS.max)
    expect(THINKING_LEVEL_LABELS.off).toBe('关闭')
  })
})

describe('resolveReasoningOptions', () => {
  test('「跟随预设」永远是第一项，并带上解析到的档位', () => {
    const options = resolveReasoningOptions({ capability: deepseek, presetEffort: 'high' })

    expect(options[0]).toEqual({
      value: DEFAULT_REASONING_OPTION,
      label: '跟随预设',
      hint: '高',
      isDefault: true,
    })
    expect(options.slice(1).map((option) => option.value)).toEqual(['off', 'low', 'high', 'xhigh', 'max'])
  })

  test('默认项按模型 capability 收敛，不显示模型不支持的档位', () => {
    const options = resolveReasoningOptions({ capability: glm, presetEffort: 'max' })

    expect(options[0]?.hint).toBe('高')
    expect(options.map((option) => option.value)).toEqual([DEFAULT_REASONING_OPTION, 'off', 'high'])
  })

  test('「关闭」带说明，其余档位不重复解释', () => {
    const options = resolveReasoningOptions({ capability: deepseek })
    const off = options.find((option) => option.value === 'off')

    expect(off?.hint).toBe('不产出思考')
    expect(options.filter((option) => option.value !== 'off' && !option.isDefault).every((option) => option.hint === undefined))
      .toBe(true)
  })

  test('没有 capability 时回退 Claude 四档', () => {
    const options = resolveReasoningOptions({ presetEffort: 'medium' })

    expect(options[0]?.hint).toBe('中')
    expect(options.slice(1).map((option) => option.value)).toEqual(['low', 'medium', 'high', 'max'])
  })
})
