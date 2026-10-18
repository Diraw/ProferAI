/**
 * Pi 模型注册的宿主兼容入口；执行实现由 provider 包维护。
 *
 * 桌面宿主在这里注入渠道账号策略（官方托管渠道判定、xAI OAuth 凭据落盘），
 * 其余注册/协议映射逻辑全部来自 @profer/agent-provider-pi。
 */
import {
  buildModel as buildProviderModel,
  buildXaiOAuthModel as buildProviderXaiOAuthModel,
  type PiModelRegistryHost,
  type XaiModelInput,
} from '@profer/agent-provider-pi/pi/model-registry'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { electronPiModelRegistryHost } from './pi-model-registry-host'

export * from '@profer/agent-provider-pi/pi/model-registry'

const host: PiModelRegistryHost = electronPiModelRegistryHost

export function buildModel(sdk: Parameters<typeof buildProviderModel>[0], input: PiAgentQueryOptions) {
  return buildProviderModel(sdk, input, host)
}

export function buildXaiOAuthModel(sdk: Parameters<typeof buildProviderXaiOAuthModel>[0], input: XaiModelInput) {
  return buildProviderXaiOAuthModel(sdk, input, host)
}
