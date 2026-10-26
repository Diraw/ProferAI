/**
 * IM Bridge 模型切换共享工具
 *
 * 为飞书 / 钉钉 / 微信 Bridge 提供统一的「渠道/模型」数据逻辑：
 * 过滤可用渠道、按序号解析渠道与模型、解析当前绑定的渠道名+模型名。
 *
 * 纯数据逻辑，不耦合任何平台的消息呈现（卡片 / 纯文本由各 Bridge 自行拼装）。
 */

import type { AgentRuntime, Channel, ChannelModel } from '@profer/shared'
import { isChannelEnabledForRuntime } from '@profer/shared'
import { listChannels, getChannelById } from './channel-manager'

/** 取渠道下启用的模型 */
export function getEnabledModels(channel: Channel): ChannelModel[] {
  return channel.models.filter((m) => m.enabled)
}

/**
 * 渠道能否用于指定 Agent 内核：已启用 + 至少一个启用模型 + 勾选了该内核。
 *
 * 只做「基础可用性」判断；`listSwitchableChannels` 在其上再做内核过滤。
 */
export function isChannelSwitchableForRuntime(channel: Channel, agentRuntime: AgentRuntime): boolean {
  return channel.enabled
    && getEnabledModels(channel).length > 0
    && isChannelEnabledForRuntime(channel, agentRuntime)
}

/**
 * 列出「可切换」的渠道：已启用且至少有一个启用模型。
 * 过滤掉停用渠道和未配置（无可用模型）的渠道，避免用户切到用不了的渠道。
 *
 * 传入 agentRuntime 时再按内核过滤：会话内核是 Pi 时不能把用户切到只勾了
 * Claude 的渠道（反之亦然），否则发送阶段才会报「渠道未启用当前内核」。
 */
export function listSwitchableChannels(agentRuntime?: AgentRuntime): Channel[] {
  const channels = listChannels().filter((c) => c.enabled && getEnabledModels(c).length > 0)
  if (!agentRuntime) return channels
  return channels.filter((c) => isChannelEnabledForRuntime(c, agentRuntime))
}

/** 按 1 起始的序号解析可切换渠道，越界返回 undefined */
export function resolveChannelByIndex(index: number, agentRuntime?: AgentRuntime): Channel | undefined {
  const channels = listSwitchableChannels(agentRuntime)
  if (!Number.isInteger(index) || index < 1 || index > channels.length) return undefined
  return channels[index - 1]
}

/**
 * 为渠道解析一个可用的模型 ID。
 *
 * 首选模型属于该渠道且启用时保留；否则取第一个启用模型。Bot 在默认渠道与内核
 * 不兼容而回退到其它渠道时，全局 agentModelId 往往不属于新渠道，必须重新选一个，
 * 否则会话会带着一个不存在的模型启动。
 */
export function resolveModelIdForChannel(channelId: string, preferredModelId?: string): string | undefined {
  const channel = getChannelById(channelId)
  if (!channel) return undefined
  const models = getEnabledModels(channel)
  if (preferredModelId && models.some((model) => model.id === preferredModelId)) return preferredModelId
  return models[0]?.id
}

/** 按 1 起始的序号解析渠道下的启用模型，越界返回 undefined */
export function resolveModelByIndex(channel: Channel, index: number): ChannelModel | undefined {
  const models = getEnabledModels(channel)
  if (!Number.isInteger(index) || index < 1 || index > models.length) return undefined
  return models[index - 1]
}

/** 建会话时选定的渠道 */
export interface RuntimeChannelSelection {
  /** 实际使用的渠道 ID */
  channelId: string
  /** 是否因为首选渠道与内核不兼容而改用了其它渠道 */
  fellBack: boolean
}

/**
 * 为指定内核挑选可用渠道。
 *
 * - 首选渠道可用 → 原样返回；
 * - 首选渠道存在但停用/无可用模型/未勾选该内核 → 回退到第一个该内核可用的渠道；
 * - 首选渠道为空（用户没选默认渠道）→ 返回 null，保持原有「请先选择渠道」提示；
 * - 没有任何该内核可用的渠道 → 返回 null，由调用方给出明确提示。
 */
export function resolveChannelIdForRuntime(
  preferredChannelId: string | undefined,
  agentRuntime: AgentRuntime,
): RuntimeChannelSelection | null {
  if (!preferredChannelId) return null

  const preferred = getChannelById(preferredChannelId)
  if (preferred && isChannelSwitchableForRuntime(preferred, agentRuntime)) {
    return { channelId: preferred.id, fellBack: false }
  }

  const fallback = listSwitchableChannels(agentRuntime)[0]
  return fallback ? { channelId: fallback.id, fellBack: true } : null
}

/** 内核展示名，用于 IM 文案 */
export function describeAgentRuntime(agentRuntime: AgentRuntime): string {
  return agentRuntime === 'pi' ? 'Pi' : 'Claude'
}

/** 解析当前绑定的渠道/模型展示信息，供 /now 使用 */
export interface BindingModelDescription {
  /** 渠道展示名（解析失败时为 channelId 原值或「未设置」） */
  channelName: string
  /** 模型展示名（解析失败时为 modelId 原值或「未设置」） */
  modelName: string
  /** 渠道与模型是否都仍有效（存在且未被删除） */
  valid: boolean
}

export function describeBindingModel(
  channelId: string | undefined,
  modelId: string | undefined,
): BindingModelDescription {
  const channel = channelId ? getChannelById(channelId) : undefined
  const model = channel && modelId ? channel.models.find((m) => m.id === modelId) : undefined

  const channelName = channel ? channel.name : channelId || '未设置'
  const modelName = model ? model.name : modelId || '未设置'
  const valid = Boolean(channel) && Boolean(model)

  return { channelName, modelName, valid }
}
