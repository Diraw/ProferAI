import { isAgentCompatibleProvider, resolveXaiCredentialMode, type Channel } from '@profer/shared'
import { decryptApiKey } from '../channel-manager'
/** 模型目录、路由和生成请求共享同一兼容性判断。 */
export function supportsPluginModel(channel: Channel, mode: 'chat' | 'agent', runtime: 'claude' | 'pi' = 'claude'): boolean {
  if (mode === 'agent') {
    if (runtime === 'claude') return isAgentCompatibleProvider(channel.provider)
    return channel.provider !== 'xai' || channel.agentExperimentalEnabled === true
  }
  if (channel.provider === 'openai-codex') return false
  if (channel.provider === 'xai') {
    try { return resolveXaiCredentialMode(channel.credentialMode, decryptApiKey(channel.id)) !== 'oauth' } catch { return false }
  }
  return true
}
