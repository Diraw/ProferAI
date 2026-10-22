/**
 * 冒烟脚本的候选渠道发现（纯函数，便于单测）。
 *
 * 背景：`agent-session-smoke.ts` 曾经内置一份**机器私有**的候选清单（个人渠道 ID 与模型 ID），
 * 于是换一台机器 / 换一个用户配置时，冒烟会因为「私有渠道不存在」而误报代码失败。
 * 现在候选一律从当前配置动态发现。
 *
 * 边界：不读配置、不碰 Electron；`channels` 与 `settings` 由调用方注入。
 */

import type { Channel } from '@profer/shared'
import { isChannelEnabledForRuntime } from '@profer/shared'

export interface SmokeCandidate {
  label: string
  channelId: string
  runtime: 'claude' | 'pi'
  modelId: string
}

export interface SmokeCandidateSettings {
  agentChannelId?: string | undefined
  agentModelId?: string | undefined
}

/** 渠道内挑一个启用模型：默认渠道的已选模型优先，否则按运行时取第一个可用模型。 */
export function pickSmokeModelId(
  channel: Channel,
  runtime: 'pi' | 'claude',
  preferred?: string | undefined,
): string | undefined {
  const enabled = channel.models.filter((model) => model.enabled && typeof model.id === 'string' && model.id.length > 0)
  if (enabled.length === 0) return undefined
  if (preferred && enabled.some((model) => model.id === preferred)) return preferred
  if (runtime === 'claude') {
    // Claude 内核需要 Claude 协议模型；优先 id 含 claude 的模型。
    return enabled.find((model) => model.id.toLowerCase().includes('claude'))?.id ?? enabled[0]?.id
  }
  // Pi 内核优先非 Claude 模型（保持 Pi 渠道的默认模型语义）。
  return (enabled.find((model) => !model.id.toLowerCase().includes('claude')) ?? enabled[0])?.id
}

/**
 * 从当前配置动态发现候选渠道。
 *
 * 顺序：默认渠道优先（保留 `settings.agentChannelId` 语义），其余保持配置顺序。
 * 只保留「已启用 + 支持目标内核 + 至少一个启用模型」的渠道；没有候选时返回空数组，
 * 调用方按 SKIP 处理（**不得**因为用户环境没有私有渠道就报代码失败）。
 */
export function discoverSmokeCandidates(
  channels: readonly Channel[],
  settings: SmokeCandidateSettings,
  preferClaude: boolean,
): SmokeCandidate[] {
  const ordered = [...channels].sort((a, b) => {
    const aDefault = a.id === settings.agentChannelId ? 1 : 0
    const bDefault = b.id === settings.agentChannelId ? 1 : 0
    return bDefault - aDefault
  })

  const candidates: SmokeCandidate[] = []
  for (const channel of ordered) {
    const supportsClaude = isChannelEnabledForRuntime(channel, 'claude')
    const supportsPi = isChannelEnabledForRuntime(channel, 'pi')
    if (!supportsClaude && !supportsPi) continue
    const runtime: 'pi' | 'claude' = preferClaude
      ? (supportsClaude ? 'claude' : 'pi')
      : (supportsPi ? 'pi' : 'claude')
    const modelId = pickSmokeModelId(
      channel,
      runtime,
      channel.id === settings.agentChannelId ? settings.agentModelId : undefined,
    )
    if (!modelId) continue
    candidates.push({ label: `${channel.name || channel.id}(${channel.id})`, channelId: channel.id, runtime, modelId })
  }
  return candidates
}
