import { describe, expect, test } from 'bun:test'
import { getChannelLogo, getModelLogo, getModelLogoById } from './model-logo'

function channel(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai' as const,
    baseUrl: 'https://api.profer.cn/v1',
    models: [],
    ...overrides,
  }
}

describe('渠道 Logo 解析', () => {
  test('OpenAI-compatible Kimi 模型池按模型品牌显示 Kimi Logo', async () => {
    const kimiLogo = await import('@/assets/models/moonshot.png')
    expect(getChannelLogo(channel({
      models: [{ id: 'kimi-k3' }],
    }))).toBe(kimiLogo.default)
  })

  test('模型别名不含品牌名时按 familyId 继承 Kimi Logo', async () => {
    const kimiLogo = await import('@/assets/models/moonshot.png')
    expect(getChannelLogo(channel({
      name: 'Kimi',
      familyId: 'kimi',
      models: [{ id: 'k3' }],
    }))).toBe(kimiLogo.default)
  })

  test('没有可识别模型时仍按明确 provider 显示 Logo', async () => {
    const openaiLogo = await import('@/assets/models/openai.png')
    expect(getChannelLogo(channel())).toBe(openaiLogo.default)
  })
})

describe('模型系列前缀匹配', () => {
  test.each([
    'gpt-6.1-sol',
    'gpt-7',
    'gpt-6.2-codex',
    'gpt-5.6-luna',
    'o3-mini',
    'chatgpt-4o-latest',
  ])('未知版本号的 OpenAI 系列模型 %s 归到 OpenAI Logo', async (modelId) => {
    const openaiLogo = await import('@/assets/models/openai.png')
    expect(getModelLogoById(modelId)).toBe(openaiLogo.default)
  })

  test.each([
    ['gemini-4-pro', '@/assets/models/gemini.png'],
    ['claude-5-opus', '@/assets/models/claude.png'],
    ['moonshot-v1-128k', '@/assets/models/moonshot.png'],
    ['devstral-medium', '@/assets/models/mixtral.png'],
    ['deepseek-v9', '@/assets/models/deepseek.png'],
  ])('同系列新版本 %s 仍匹配到品牌 Logo', async (modelId, logoPath) => {
    const logo = await import(logoPath)
    expect(getModelLogoById(modelId)).toBe(logo.default)
  })

  test('具体子品牌规则优先于系列兜底', async () => {
    const deepGeminiLogo = await import('@/assets/models/deepgemini.png')
    const codestralLogo = await import('@/assets/models/codestral.png')
    expect(getModelLogoById('deepgemini-2.5-pro')).toBe(deepGeminiLogo.default)
    expect(getModelLogoById('codestral-2508')).toBe(codestralLogo.default)
  })

  test('o 系列锚定开头，不误伤其他 ID', () => {
    expect(getModelLogoById('my-model-o1-preview')).toBeUndefined()
  })

  test('模型命中系列规则时不再落到供应商默认图标', async () => {
    const openaiLogo = await import('@/assets/models/openai.png')
    expect(getModelLogo('gpt-6.1-sol', 'custom')).toBe(openaiLogo.default)
  })

  test('完全无法识别的模型仍回退供应商/默认图标', async () => {
    const defaultLogo = await import('@/assets/models/default.png')
    expect(getModelLogo('k3', 'custom')).toBe(defaultLogo.default)
  })
})
