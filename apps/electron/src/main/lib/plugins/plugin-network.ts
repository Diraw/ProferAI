import { pluginCredentialHeader } from './plugin-credentials'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request } from 'node:https'
import type { ProferPluginFetchResult } from '@profer/plugin-api'
import { fetchSchema } from './plugin-capabilities'
import { assertPluginOrigin } from './plugin-permissions'

const blockedV4 = new BlockList()
const blockedV6 = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blockedV4.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blockedV6.addSubnet(network, prefix, 'ipv6')
export function isPublicPluginAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blockedV4.check(address, 'ipv4') : family === 6 && !blockedV6.check(address, 'ipv6')
}
/** DNS 解析后固定连接地址；拒绝重定向，避免绕过域名授权或访问内网。 */
export async function fetchPluginNetwork(pluginId: string, raw: unknown, signal: AbortSignal): Promise<ProferPluginFetchResult> {
  const input = fetchSchema.parse(raw), url = new URL(input.url)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('插件仅支持不含凭据的 HTTPS 地址')
  assertPluginOrigin(pluginId, url.origin)
  const headers = { ...(input.headers ?? {}) }
  if (input.credentialId) {
    for (const name of Object.keys(headers)) if (/^(authorization|x-api-key)$/i.test(name)) delete headers[name]
    Object.assign(headers, pluginCredentialHeader(pluginId, input.credentialId, url.origin))
  }
  if (Object.keys(headers).length > 30 || Object.keys(headers).some((name) => /^(host|cookie|proxy-.*|connection|upgrade|content-length|transfer-encoding|te|trailer)$/i.test(name))) throw new Error('请求头包含不支持的字段')
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!addresses.length || addresses.some((item) => !isPublicPluginAddress(item.address))) throw new Error('插件不能请求本地、内网或保留地址')
  signal.throwIfAborted()
  const address = addresses[0]!
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: input.method, headers, signal, agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address])
        else callback(null, address.address, address.family)
      },
    }, (response) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.destroy(); reject(new Error('插件网络请求不自动跟随重定向')); return
      }
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) { response.destroy(new Error('网络响应超过 2 MB')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const safeHeaders: Record<string, string> = {}
        for (const name of ['content-type', 'etag', 'last-modified', 'retry-after']) {
          const value = response.headers[name]
          if (typeof value === 'string') safeHeaders[name] = value
        }
        resolve({ status: response.statusCode ?? 0, headers: safeHeaders, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end(input.body)
  })
}
