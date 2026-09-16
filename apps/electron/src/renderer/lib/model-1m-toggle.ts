/**
 * 渠道配置里的「1M」勾选状态解析。
 *
 * 1M 上下文是模型 + 渠道能力，三态：
 * - 缺省：跟随自动判定（模型与 provider 都被验证过才开）
 * - true / false：用户在模型行上显式强开或强关
 *
 * UI 必须显示**生效结果**（而不是只显示显式字段），否则已验证的 DeepSeek V4
 * 这类自动开启的模型会显示成未勾选，用户会误以为没生效。
 */

import { resolveOneMillionContextDecision, type OneMillionContextSource, type ProviderType } from '@profer/shared'
import type { ChannelModel } from '@profer/shared'

export interface Model1MToggleState {
  /** 生效结果：该模型当前是否按 1M 上下文处理 */
  enabled: boolean
  /** 生效来源 */
  source: OneMillionContextSource
  /** 点击后应写入的显式偏好 */
  nextExplicit: boolean
  /** 悬停说明（含当前来源与点击后果） */
  title: string
}

/** 解析模型行的 1M 勾选状态与下一步取值。 */
export function resolveModel1MToggleState(
  model: Pick<ChannelModel, 'id' | 'context1m'>,
  provider: ProviderType,
): Model1MToggleState {
  const decision = resolveOneMillionContextDecision(model.id, provider, model.context1m)
  return {
    enabled: decision.enabled,
    source: decision.source,
    nextExplicit: !decision.enabled,
    title: buildModel1MTitle(decision.enabled, decision.source),
  }
}

function buildModel1MTitle(enabled: boolean, source: OneMillionContextSource): string {
  switch (source) {
    case 'forced-on':
      return '已手动开启 1M 上下文，该模型在任何渠道上都按 1M 处理（能否真正协商由端点决定）。点击改为关闭。'
    case 'forced-off':
      return '已手动关闭 1M 上下文，即使模型与渠道都验证支持也不按 1M 处理。点击改为开启。'
    case 'auto':
      return enabled
        ? '自动：该模型与渠道已验证支持 1M 上下文。点击可强制关闭。'
        : '自动：该模型或渠道未通过 1M 验证，当前按默认窗口处理。点击可强制开启（能否生效由端点决定）。'
  }
}
