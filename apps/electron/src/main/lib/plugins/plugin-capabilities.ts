import { z } from 'zod'
import { PROFER_PLUGIN_PAGE_ID_PATTERN, type ProferPluginContributions, type ProferPluginManifest } from '@profer/plugin-api'

const id = z.string().max(80).regex(PROFER_PLUGIN_PAGE_ID_PATTERN)
const title = z.string().trim().min(1).max(80)
const parameter = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().max(500).optional(),
  required: z.boolean().optional(),
})
const tool = z.object({
  id: id.max(34), title, description: z.string().trim().min(1).max(2000), pageId: id,
  parameters: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), parameter)
    .refine((value) => Object.keys(value).length <= 30, '工具参数最多 30 个'),
})
export function parsePluginCapabilities(raw: Record<string, unknown>, pages: Array<{ id: string }> = []): {
  network?: ProferPluginManifest['network']; contributions: Pick<ProferPluginContributions, 'tools' | 'messageActions'>
} {
  const contributes = raw.contributes as Record<string, unknown>
  const tools = z.array(tool).max(30).optional().parse(contributes.tools)
  const messageActions = z.array(z.object({ id, title, pageId: id })).max(20).optional().parse(contributes.messageActions)
  for (const list of [tools, messageActions]) {
    if (list && new Set(list.map((item) => item.id)).size !== list.length) throw new Error('插件贡献 id 不能重复')
    for (const item of list ?? []) {
      if (!pages.some((page) => page.id === item.pageId)) throw new Error(`插件贡献引用了不存在的页面：${item.pageId}`)
    }
  }
  const network = z.object({ origins: z.array(z.string().max(300).refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.hostname.includes('*')
    } catch { return false }
  }, '网络权限必须声明精确 HTTPS origin')).max(20),
    credentials: z.array(z.object({ id, title, origin: z.string().max(300), header: z.enum(['Authorization', 'X-API-Key']), scheme: z.enum(['bearer', 'raw']).optional() })).max(10).optional(),
  }).optional().parse(raw.network)
  if (network?.credentials) {
    if (new Set(network.credentials.map((credential) => credential.id)).size !== network.credentials.length) throw new Error('凭据 id 不能重复')
    if (network.credentials.some((credential) => !network.origins.includes(credential.origin))) throw new Error('凭据只能绑定已声明的网络域名')
  }
  const permissions = raw.permissions as string[] | undefined
  if (tools?.length && !permissions?.includes('agent.tools')) throw new Error('工具贡献需要 agent.tools 权限')
  if (network?.origins.length && !permissions?.includes('network.fetch')) throw new Error('网络域名需要 network.fetch 权限')
  return { ...(network && { network }), contributions: { ...(tools && { tools }), ...(messageActions && { messageActions }) } }
}

export const routingRulesSchema = z.array(z.object({
  id, title, channelId: z.string().min(1).max(200), modelId: z.string().min(1).max(200),
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
})).max(50).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, '路由规则 id 不能重复')
export const taskReferenceSchema = z.object({
  kind: z.enum(['chat', 'agent']), sessionId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200).optional(), selection: z.string().max(100_000).optional(),
})
export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
export const generateSchema = z.object({
  requestId: requestIdSchema, channelId: z.string().min(1).max(200), modelId: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000), system: z.string().max(20_000).optional(),
  maxTokens: z.number().int().min(1).max(8192).default(2048),
})
export const fetchSchema = z.object({
  requestId: requestIdSchema, credentialId: id.optional(), url: z.string().max(4000).url(), method: z.enum(['GET', 'POST']).default('GET'),
  headers: z.record(z.string().max(100), z.string().max(8000)).optional(), body: z.string().max(1_000_000).optional(),
})
