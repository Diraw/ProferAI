import type { Channel } from '@profer/shared'
import { isCommercialBuild } from './build-target'
import { isCommercialMode } from './channel-manager'
import { isOfficialManagedChannel } from './official-channel'

/**
 * 商业侧旁装配的最小路由策略。
 *
 * 这里只表达“是否应进入官方代管通道”，不解析账号、额度、OAuth 或供应商错误。
 * OSS 与自配渠道继续沿用公共凭据/直连路径。
 */
export function shouldUseManagedCommercialRoute(
  channel: Pick<Channel, 'id' | 'serverManaged' | 'directDataPlane'>,
  options: { respectDirectDataPlane?: boolean } = {},
): boolean {
  return (isCommercialBuild() || isCommercialMode())
    && isOfficialManagedChannel(channel)
    && (!options.respectDirectDataPlane || channel.directDataPlane !== true)
}

export function shouldUseCommercialBearerAuth(
  channel: Pick<Channel, 'id' | 'serverManaged' | 'directDataPlane'>,
): boolean {
  return (isCommercialBuild() || isCommercialMode()) && isOfficialManagedChannel(channel)
}
