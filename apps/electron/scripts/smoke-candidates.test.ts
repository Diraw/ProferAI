import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { discoverSmokeCandidates, pickSmokeModelId } from './smoke-candidates'

/**
 * 回归背景：冒烟脚本曾内置机器私有的候选清单（个人渠道 ID + 模型 ID），
 * 换机器 / 换用户配置时会因为「私有渠道不存在」误报代码失败。
 * 现在候选必须从当前配置动态发现，且没有候选时按 SKIP 处理。
 */

function channel(overrides: Partial<Channel> & Pick<Channel, 'id'>): Channel {
  return {
    name: overrides.id,
    provider: 'openai',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'cipher',
    enabled: true,
    agentRuntimes: ['pi'],
    models: [{ id: 'gpt-fixture', name: 'GPT Fixture', enabled: true }],
    ...overrides,
  } as Channel
}

describe('pickSmokeModelId', () => {
  test('Given 默认渠道已选模型仍在启用列表 When 挑选 Then 用已选模型', () => {
    const target = channel({ id: 'c1', models: [
      { id: 'm-1', name: 'M1', enabled: true },
      { id: 'm-2', name: 'M2', enabled: true },
    ] })
    expect(pickSmokeModelId(target, 'pi', 'm-2')).toBe('m-2')
  })

  test('Given 已选模型被禁用 When 挑选 Then 回退到启用模型而不是用禁用项', () => {
    const target = channel({ id: 'c1', models: [
      { id: 'm-1', name: 'M1', enabled: false },
      { id: 'm-2', name: 'M2', enabled: true },
    ] })
    expect(pickSmokeModelId(target, 'pi', 'm-1')).toBe('m-2')
  })

  test('Given 全部模型被禁用 When 挑选 Then 无候选（不猜模型）', () => {
    const target = channel({ id: 'c1', models: [{ id: 'm-1', name: 'M1', enabled: false }] })
    expect(pickSmokeModelId(target, 'pi')).toBeUndefined()
  })

  test('Given Claude 内核 When 挑选 Then 优先 Claude 协议模型', () => {
    const target = channel({ id: 'c1', models: [
      { id: 'deepseek-fixture', name: 'DS', enabled: true },
      { id: 'claude-fixture-4', name: 'Claude', enabled: true },
    ] })
    expect(pickSmokeModelId(target, 'claude')).toBe('claude-fixture-4')
  })

  test('Given Pi 内核 When 挑选 Then 优先非 Claude 模型', () => {
    const target = channel({ id: 'c1', models: [
      { id: 'claude-fixture-4', name: 'Claude', enabled: true },
      { id: 'gpt-fixture', name: 'GPT', enabled: true },
    ] })
    expect(pickSmokeModelId(target, 'pi')).toBe('gpt-fixture')
  })
})

describe('discoverSmokeCandidates', () => {
  const defaultSettings = { agentChannelId: 'c-default', agentModelId: 'default-model' }

  test('Given 多个启用渠道 When 发现 Then 默认渠道排第一且不再依赖任何私有 ID', () => {
    const candidates = discoverSmokeCandidates([
      channel({ id: 'c-other' }),
      channel({ id: 'c-default', models: [
        { id: 'other-model', name: 'Other', enabled: true },
        { id: 'default-model', name: 'Default', enabled: true },
      ] }),
    ], defaultSettings, false)

    expect(candidates.map((candidate) => candidate.channelId)).toEqual(['c-default', 'c-other'])
    expect(candidates[0]?.modelId).toBe('default-model')
    expect(candidates[0]?.runtime).toBe('pi')
  })

  test('Given 渠道被禁用或只支持 Claude When 发现 Then 禁用的跳过，仅 Claude 的按 claude 运行', () => {
    const candidates = discoverSmokeCandidates([
      channel({ id: 'disabled', enabled: false }),
      channel({ id: 'claude-only', agentRuntimes: ['claude'], models: [{ id: 'claude-fixture-4', name: 'Claude', enabled: true }] }),
      channel({ id: 'usable' }),
    ], { agentChannelId: undefined }, false)

    expect(candidates).toEqual([
      { label: 'claude-only(claude-only)', channelId: 'claude-only', runtime: 'claude', modelId: 'claude-fixture-4' },
      { label: 'usable(usable)', channelId: 'usable', runtime: 'pi', modelId: 'gpt-fixture' },
    ])
  })

  test('Given 没有可用渠道 When 发现 Then 返回空数组（调用方按 SKIP 处理，不误报失败）', () => {
    expect(discoverSmokeCandidates([], {}, false)).toEqual([])
    expect(discoverSmokeCandidates([channel({ id: 'off', enabled: false })], {}, false)).toEqual([])
  })

  test('Given --claude 偏好 When 渠道同时支持两个内核 Then 选 Claude；只支持 Pi 时仍选 Pi', () => {
    const candidates = discoverSmokeCandidates([
      channel({ id: 'both', agentRuntimes: ['pi', 'claude'], models: [
        { id: 'gpt-fixture', name: 'GPT', enabled: true },
        { id: 'claude-fixture-4', name: 'Claude', enabled: true },
      ] }),
      channel({ id: 'pi-only', agentRuntimes: ['pi'] }),
    ], {}, true)

    expect(candidates).toEqual([
      { label: 'both(both)', channelId: 'both', runtime: 'claude', modelId: 'claude-fixture-4' },
      { label: 'pi-only(pi-only)', channelId: 'pi-only', runtime: 'pi', modelId: 'gpt-fixture' },
    ])
  })

  test('Given 渠道没有任何启用模型 When 发现 Then 不产生半可用候选', () => {
    const candidates = discoverSmokeCandidates([
      channel({ id: 'empty-models', models: [] }),
    ], {}, false)
    expect(candidates).toEqual([])
  })
})
