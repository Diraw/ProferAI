/**
 * 手动公网连接地址（用户自建 FRP / 端口映射场景）。
 *
 * 用户在设置页填一组「公网 IP 或域名 + 端口」，桌面把它写进配对二维码，
 * 手机扫码后即可在外网直连，无需手动输入地址。
 *
 * 信任规则（与配对二维码 v3 一致）：
 * - 公网 IP：桌面自己起自签 TLS（复用 remote-tls-identity），二维码带 SPKI pin，手机严格校验；
 * - 公网域名：假定用户自己的反向代理终止 TLS，二维码只带 wss 地址，走系统可信证书。
 *
 * 配置与 TLS 身份都落在配置目录，不进 settings.json：地址变化会换证书与 pin。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { app } from 'electron'
import { validateEndpoint, type RemoteEndpoint } from '@profer/shared'
import { getConfigDir } from './config-paths'
import { protectSecret, revealSecret } from './remote-identity'
import { RemoteTlsStore, type TlsIdentity } from './remote-tls-identity'

export interface PublicEndpointConfig {
  /** 公网 IP（v4/v6，不带方括号）或域名 */
  host: string
  /** 公网端口（frps 映射出来的那个端口） */
  port: number
}

export interface PublicEndpointInfo extends PublicEndpointConfig {
  /** 二维码/手机使用的完整 WSS 地址 */
  url: string
  trustMode: 'pinned' | 'system'
  /** 仅 IP 端点有：手机手动连接时需要填的证书指纹 */
  pin: string | null
}

const FILE = 'remote-public-endpoint.json'
const HOST_PATTERN = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/

function configFile(): string { return join(getConfigDir(), FILE) }

/** 规范化用户输入：去空格、去 IPv6 方括号；非法直接抛错。 */
export function normalizePublicEndpoint(input: unknown): PublicEndpointConfig {
  if (!input || typeof input !== 'object') throw new Error('公网地址参数无效')
  const raw = input as { host?: unknown; port?: unknown }
  const host = String(raw.host ?? '').trim().replace(/^\[|\]$/g, '')
  const port = typeof raw.port === 'number' ? raw.port : Number(raw.port)
  if (!host) throw new Error('请填写公网 IP 或域名')
  if (!isIP(host) && !HOST_PATTERN.test(host)) throw new Error('公网地址格式无效，请填 IP 或域名')
  // 443 是 wss 的标准端口（域名场景常见），其余要求 1024-65535 避开特权端口。
  if (!Number.isInteger(port) || (port !== 443 && (port < 1024 || port > 65535))) throw new Error('公网端口必须是 443 或 1024-65535 之间的整数')
  return { host, port }
}

export function loadPublicEndpointConfig(): PublicEndpointConfig | null {
  const file = configFile()
  if (!existsSync(file)) return null
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { host?: unknown; port?: unknown }
    return normalizePublicEndpoint(saved)
  } catch {
    // 配置损坏按未配置处理，不阻塞移动模式启动。
    return null
  }
}

/** 保存（传 null 表示清除）。返回规范化后的配置。 */
export function savePublicEndpointConfig(input: unknown): PublicEndpointConfig | null {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  const file = configFile()
  if (input === null) {
    if (existsSync(file)) rmSync(file, { force: true })
    return null
  }
  const next = normalizePublicEndpoint(input)
  writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return next
}

function tlsStore(): RemoteTlsStore {
  return new RemoteTlsStore(join(app.getPath('userData'), 'remote-tls-public'), protectSecret, revealSecret)
}

/** 公网 IP 场景下的自签 TLS 身份；域名场景返回 null（由用户自己的反代终止 TLS）。 */
export async function ensurePublicTlsIdentity(): Promise<TlsIdentity | null> {
  const config = loadPublicEndpointConfig()
  if (!config || !isIP(config.host)) return null
  return tlsStore().ensure(config.host)
}

/** 已存在且与当前配置匹配的 TLS 身份；不触发证书生成。 */
export function peekPublicTlsIdentity(): TlsIdentity | null {
  const config = loadPublicEndpointConfig()
  if (!config || !isIP(config.host)) return null
  try { return tlsStore().load() } catch { return null }
}

export function getPublicEndpointInfo(): PublicEndpointInfo | null {
  const config = loadPublicEndpointConfig()
  if (!config) return null
  const ip = isIP(config.host) !== 0
  const host = ip && config.host.includes(':') ? `[${config.host}]` : config.host
  const identity = ip ? peekPublicTlsIdentity() : null
  const trustMode = ip ? 'pinned' : 'system'
  return {
    ...config,
    url: `wss://${host}:${config.port}/ws`,
    trustMode,
    // 证书尚未生成时先返回 null，UI 提示「保存后生成」；二维码生成会先确保身份存在。
    pin: identity?.pin.value ?? null,
  }
}

/** 供连接资料与二维码使用的公网端点；未配置或 IP 场景缺证书时返回 undefined。 */
export function getPublicEndpoint(): RemoteEndpoint | undefined {
  const config = loadPublicEndpointConfig()
  if (!config) return undefined
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  const url = `wss://${host}:${config.port}/ws`
  if (!isIP(config.host)) return validateEndpoint({ url, scope: 'public', trustMode: 'system' })
  const identity = peekPublicTlsIdentity()
  if (!identity || identity.publicIp !== config.host) return undefined
  return validateEndpoint({ url, scope: 'public', trustMode: 'pinned', pin: identity.pin })
}
