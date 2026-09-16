import type { AgentRuntime, Channel } from '@profer/shared'
import { isChannelEnabledForRuntime } from '@profer/shared'
import { getChannelProtocol } from './channel-model-groups'

/** Pi can use every enabled channel without changing Claude's compatibility whitelist. */
export function nextAgentChannelIdsAfterModelSelect(
  currentChannelIds: string[],
  selectedChannelId: string,
  runtime: AgentRuntime,
): string[] {
  if (runtime !== 'claude') return currentChannelIds
  return currentChannelIds.includes(selectedChannelId)
    ? currentChannelIds
    : [...currentChannelIds, selectedChannelId]
}

export interface AgentModelSelection {
  channelId: string
  modelId: string
}

/** Resolve a model that is valid for the selected Agent runtime. */
export function resolveAgentModelSelection(
  channels: Channel[],
  runtime: AgentRuntime,
  claudeChannelIds: string[],
  current?: AgentModelSelection | null,
): AgentModelSelection | null {
  const preferredProtocol = runtime === 'pi' ? 'openai' : 'anthropic'
  /**
   * 可用性判定改为按渠道上用户勾选的 Agent 内核（`agentRuntimes`），不再按渠道类型。
   * 未迁移的老配置（agentRuntimes === undefined）仍用历史 Claude 白名单兜底，
   * 保证升级瞬间的行为不变。
   */
  const isEligibleChannel = (channel: Channel): boolean => {
    if (!channel.enabled) return false
    if (runtime !== 'pi' && channel.agentRuntimes === undefined) return claudeChannelIds.includes(channel.id)
    return isChannelEnabledForRuntime(channel, runtime === 'pi' ? 'pi' : 'claude')
  }

  if (current) {
    const channel = channels.find((item) => item.id === current.channelId)
    if (channel && isEligibleChannel(channel) && channel.models.some((model) => model.enabled && model.id === current.modelId)) {
      return current
    }
  }

  // Preserve the existing OpenAI-first fallback for Pi, while allowing Claude
  // as the fallback when no OpenAI-compatible channel has an enabled model.
  const eligibleChannels = channels.filter(isEligibleChannel)
  const orderedChannels = runtime === 'pi'
    ? [
        ...eligibleChannels.filter((channel) => getChannelProtocol(channel.provider) === 'openai'),
        ...eligibleChannels.filter((channel) => getChannelProtocol(channel.provider) !== 'openai'),
      ]
    : eligibleChannels
  for (const channel of orderedChannels) {
    const model = channel.models.find((item) => item.enabled)
    if (model) return { channelId: channel.id, modelId: model.id }
  }

  return null
}
