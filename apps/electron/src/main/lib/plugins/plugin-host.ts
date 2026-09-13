import type { ProferPluginPermission, ProferPluginTaskReference } from '@profer/plugin-api'
import { assertPluginPermission } from './plugin-permissions'
import { listPluginModels, generatePluginModel } from './plugin-models'
import { getPluginRoutingRules, setPluginRoutingRules } from './plugin-routing'
import { fetchPluginNetwork } from './plugin-network'
import { readPluginTaskContext, selectPluginAttachments } from './plugin-context'
import { fetchSchema, generateSchema, requestIdSchema } from './plugin-capabilities'
import { pluginRequests } from './plugin-requests'

const permissions: Record<string, ProferPluginPermission> = {
  'models.list': 'models.read', 'models.generate': 'models.invoke', 'routing.get': 'modelRouting.rules.write',
  'routing.set': 'modelRouting.rules.write', 'context.read': 'context.read', 'attachments.select': 'attachments.read', 'network.fetch': 'network.fetch',
}
export async function callPluginHost(pluginId: string, method: unknown, input: unknown, context: ProferPluginTaskReference | null, ownerId: number): Promise<unknown> {
  if (method === 'requests.cancel') { pluginRequests.cancel(pluginId, requestIdSchema.parse(input)); return }
  if (typeof method !== 'string' || !Object.hasOwn(permissions, method)) throw new Error('未知的插件宿主操作')
  const permission = permissions[method]!
  assertPluginPermission(pluginId, permission)
  let result: unknown
  switch (method) {
    case 'models.list': return listPluginModels()
    case 'routing.get': return getPluginRoutingRules(pluginId)
    case 'routing.set': return setPluginRoutingRules(pluginId, input)
    case 'context.read': return readPluginTaskContext(context)
    case 'attachments.select': result = await selectPluginAttachments(); break
    case 'models.generate': {
      const args = generateSchema.parse(input)
      result = await pluginRequests.run(pluginId, args.requestId, (signal) => generatePluginModel(args, signal), 120_000, ownerId)
      break
    }
    case 'network.fetch': {
      const args = fetchSchema.parse(input)
      result = await pluginRequests.run(pluginId, args.requestId, (signal) => fetchPluginNetwork(pluginId, args, signal), 60_000, ownerId)
      break
    }
  }
  // 等待过程中可能被撤权；结果也不能继续交回插件。
  assertPluginPermission(pluginId, permission)
  return result
}
