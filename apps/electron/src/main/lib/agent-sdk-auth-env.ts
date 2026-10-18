/**
 * 兼容宿主旧入口；实现由 @profer/agent-provider-claude 维护。
 *
 * Electron 侧显式传入应用版本（Electron package.json version），与迁移前
 * applyAgentSdkAuthEnv(env, provider, apiKey, forceBearerAuth) 的行为逐字节一致。
 */
import type { ProviderType } from '@profer/shared'
import {
  applyAgentSdkAuthEnv as applyAgentSdkAuthEnvWithVersion,
  usesAgentSdkBearerWithUserAgent,
} from '@profer/agent-provider-claude'
import pkg from '../../../package.json' with { type: 'json' }

export { usesAgentSdkBearerWithUserAgent }

/** 这些 Anthropic-compatible 计划渠道要求 Bearer token 和固定 User-Agent。 */
export function applyAgentSdkAuthEnv(
  target: Record<string, string | undefined>,
  provider: ProviderType,
  apiKey: string,
  forceBearerAuth = false,
): void {
  applyAgentSdkAuthEnvWithVersion(target, provider, apiKey, forceBearerAuth, pkg.version)
}
