import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelsConfig } from '@profer/shared'
import {
  listSwitchableChannels,
  resolveChannelByIndex,
  resolveChannelIdForRuntime,
  resolveModelIdForChannel,
} from './bridge-model-utils'

const configDir = mkdtempSync(join(tmpdir(), 'profer-bridge-model-utils-'))
const channelsPath = join(configDir, 'channels.json')
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function channel(
  id: string,
  agentRuntimes: Array<'pi' | 'claude'>,
  overrides: Partial<ChannelsConfig['channels'][number]> = {},
): ChannelsConfig['channels'][number] {
  return {
    id,
    name: id,
    provider: 'custom',
    baseUrl: 'https://example.com/v1',
    agentBaseUrl: 'https://example.com/v1',
    apiKey: 'test-secret',
    models: [{ id: `${id}-model`, name: `${id} model`, enabled: true }],
    enabled: true,
    agentRuntimes,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function writeChannels(channels: ChannelsConfig['channels']): void {
  writeFileSync(channelsPath, JSON.stringify({ version: 1, channels }, null, 2), 'utf-8')
}

beforeEach(() => {
  process.env.PROFER_CONFIG_DIR = configDir
  writeChannels([
    channel('pi-only', ['pi']),
    channel('claude-only', ['claude']),
    channel('dual', ['pi', 'claude']),
    channel('pi-disabled', ['pi'], { enabled: false }),
    channel('pi-no-model', ['pi'], { models: [{ id: 'off', name: 'off', enabled: false }] }),
  ])
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('Bridge 渠道内核过滤', () => {
  test('Given 渠道混合配置 When 按 Pi 过滤 Then 只保留勾选 Pi 且可用的渠道', () => {
    expect(listSwitchableChannels('pi').map((c) => c.id)).toEqual(['pi-only', 'dual'])
  })

  test('Given 渠道混合配置 When 按 Claude 过滤 Then 只保留勾选 Claude 且可用的渠道', () => {
    expect(listSwitchableChannels('claude').map((c) => c.id)).toEqual(['claude-only', 'dual'])
  })

  test('Given 未传内核 When 列出渠道 Then 保持历史行为（只按启用状态与模型过滤）', () => {
    expect(listSwitchableChannels().map((c) => c.id)).toEqual(['pi-only', 'claude-only', 'dual'])
  })

  test('Given 按 Pi 过滤 When 用序号解析渠道 Then 序号基于过滤后的列表', () => {
    expect(resolveChannelByIndex(1, 'pi')?.id).toBe('pi-only')
    expect(resolveChannelByIndex(2, 'pi')?.id).toBe('dual')
    expect(resolveChannelByIndex(3, 'pi')).toBeUndefined()
  })

  test('Given 按 Claude 过滤 When 用序号解析渠道 Then 不会解析到 Pi-only 渠道', () => {
    expect(resolveChannelByIndex(1, 'claude')?.id).toBe('claude-only')
    expect(resolveChannelByIndex(1, 'claude')?.id).not.toBe('pi-only')
  })
})

describe('Bridge 建会话渠道选择', () => {
  test('Given 首选渠道与内核兼容 When 解析 Then 原样返回且不标记回退', () => {
    expect(resolveChannelIdForRuntime('pi-only', 'pi')).toEqual({ channelId: 'pi-only', fellBack: false })
  })

  test('Given 首选渠道只勾选 Claude When 会话是 Pi Then 回退到可用渠道', () => {
    expect(resolveChannelIdForRuntime('claude-only', 'pi')).toEqual({ channelId: 'pi-only', fellBack: true })
  })

  test('Given 首选渠道已停用 When 解析 Then 回退到可用渠道', () => {
    expect(resolveChannelIdForRuntime('pi-disabled', 'pi')).toEqual({ channelId: 'pi-only', fellBack: true })
  })

  test('Given 未配置首选渠道 When 解析 Then 返回 null（保留「请先选择渠道」提示）', () => {
    expect(resolveChannelIdForRuntime(undefined, 'pi')).toBeNull()
    expect(resolveChannelIdForRuntime('', 'pi')).toBeNull()
  })

  test('Given 没有任何该内核可用渠道 When 解析 Then 返回 null', () => {
    writeChannels([channel('pi-only', ['pi'])])
    expect(resolveChannelIdForRuntime('pi-only', 'claude')).toBeNull()
  })
})

describe('Bridge 渠道模型解析', () => {
  test('Given 首选模型属于渠道 When 解析 Then 保留首选模型', () => {
    expect(resolveModelIdForChannel('pi-only', 'pi-only-model')).toBe('pi-only-model')
  })

  test('Given 首选模型不属于回退渠道 When 解析 Then 取该渠道第一个启用模型', () => {
    expect(resolveModelIdForChannel('pi-only', 'dual-model')).toBe('pi-only-model')
  })

  test('Given 渠道不存在 When 解析 Then 返回 undefined', () => {
    expect(resolveModelIdForChannel('missing')).toBeUndefined()
  })
})
