import type { EditionProviders } from '@profer/edition-contract'
import { getTeamAuthWithRefresh, recoverCommercialProxyAuth } from '../auth-service'
import { isCommercialBuild } from '../build-target'
import { shouldUseCommercialBearerAuth, shouldUseManagedCommercialRoute } from '../commercial-routing-policy'

/**
 * 执行链唯一的商业能力装配点。
 *
 * 阶段 A 保持现有行为：account 与 credentials 仍委托 auth-service /
 * commercial-routing-policy，只把直接依赖从执行链移到本模块。
 * 阶段 B 在这里按发行版切换实现（OSS 注入本地实现、Commercial 注入商业适配），
 * chat-service / agent-orchestrator / agent-runtime-credentials / plugin-models
 * 不需要再改。
 */
export const editionProviders: EditionProviders = {
  id: isCommercialBuild() ? 'commercial' : 'oss',
  account: {
    getSession: () => getTeamAuthWithRefresh(),
    recoverSession: () => recoverCommercialProxyAuth(),
  },
  credentials: {
    shouldUseManagedRoute: shouldUseManagedCommercialRoute,
    shouldUseBearerAuth: shouldUseCommercialBearerAuth,
  },
}
