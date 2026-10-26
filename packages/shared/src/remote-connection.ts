export const REMOTE_PROTOCOL = 'profer.remote.v1'
export const PAIRING_TTL_MS = 300_000
export interface RemotePin { algorithm: 'spki-sha256'; value: string }
export interface RemoteEndpoint { url: string; scope: 'lan' | 'public'; trustMode?: 'pinned' | 'system'; pin?: RemotePin }
export interface RemoteProfile { schemaVersion: 1 | 2; deviceId: string; deviceName: string; updatedAt: number; endpoints: RemoteEndpoint[] }
export interface PairingQr extends RemoteProfile { kind: 'profer-pairing'; issuedAt: number; expiresAt: number; pairingCode: string }
const PROFILE_KEYS = ['schemaVersion', 'deviceId', 'deviceName', 'updatedAt', 'endpoints']
const QR_KEYS = [...PROFILE_KEYS, 'kind', 'issuedAt', 'expiresAt', 'pairingCode']
function record(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new Error('连接资料必须是普通对象')
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error('连接资料包含未知字段')
  return input as Record<string, unknown>
}
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(h)) return true
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false
  const parts = h.split('.').map(Number)
  if (parts.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
}
export function validateEndpoint(input: unknown): RemoteEndpoint {
  const e = record(input, ['url', 'scope', 'trustMode', 'pin'])
  if (typeof e.url !== 'string' || e.url.length > 512 || (e.scope !== 'lan' && e.scope !== 'public')) throw new Error('连接端点无效')
  let u: URL
  try { u = new URL(e.url) } catch { throw new Error('连接端点无效') }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/ws') throw new Error('端点不得包含凭据或查询参数')
  if (e.scope === 'lan' && !isPrivateHost(u.hostname)) throw new Error('局域网端点必须是私网地址')
  if (u.protocol !== 'wss:' && !(e.scope === 'lan' && u.protocol === 'ws:' && isPrivateHost(u.hostname))) throw new Error('公网连接必须使用可信 WSS')
  if (e.trustMode !== undefined && e.trustMode !== 'system' && e.trustMode !== 'pinned') throw new Error('未知 TLS 信任模式')
  if (e.scope === 'lan' && (e.trustMode !== undefined || e.pin !== undefined)) throw new Error('局域网端点不能携带公网信任字段')
  if (e.trustMode === 'pinned') {
    if (e.scope !== 'public' || u.protocol !== 'wss:') throw new Error('Pin 仅用于公网 WSS')
    const p = record(e.pin, ['algorithm', 'value'])
    if (p.algorithm !== 'spki-sha256' || typeof p.value !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(p.value)) throw new Error('SPKI SHA256 pin 无效')
    // SHA256 的最后一个 base64 字符必须是规范编码，不能接受模糊等价值。
    if (!/[AEIMQUYcgkosw048]=$/.test(p.value)) throw new Error('pin 编码无效')
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':')) throw new Error('Pinned 地址必须是 IP')
    return { url: u.toString(), scope: e.scope, trustMode: 'pinned', pin: { algorithm: 'spki-sha256', value: p.value } }
  }
  if (e.pin !== undefined) throw new Error('系统可信端点不能携带 pin')
  return { url: u.toString(), scope: e.scope, ...(e.trustMode === 'system' ? { trustMode: 'system' as const } : {}) }
}
function profile(p: Record<string, unknown>): RemoteProfile {
  if (p.schemaVersion !== 1 && p.schemaVersion !== 2) throw new Error('不支持的连接资料版本')
  if (typeof p.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(p.deviceId) || typeof p.deviceName !== 'string' || !p.deviceName.trim() || p.deviceName.length > 120 || typeof p.updatedAt !== 'number' || !Number.isSafeInteger(p.updatedAt) || p.updatedAt < 0) throw new Error('设备身份无效')
  if (!Array.isArray(p.endpoints) || p.endpoints.length < 1 || p.endpoints.length > 16) throw new Error('连接端点无效')
  const endpoints = p.endpoints.map(validateEndpoint)
  if (new Set(endpoints.map((e) => e.url)).size !== endpoints.length) throw new Error('连接端点重复')
  if (p.schemaVersion === 1 && endpoints.some((e) => e.trustMode !== undefined || e.pin !== undefined)) throw new Error('v1 不支持 pin；请重新扫码')
  if (p.schemaVersion === 2 && endpoints.some((e) => e.scope === 'public' && !e.trustMode)) throw new Error('v2 公网端点必须指定信任模式')
  return { schemaVersion: p.schemaVersion, deviceId: p.deviceId, deviceName: p.deviceName, updatedAt: p.updatedAt, endpoints }
}
// 网络只可更新已绑定身份的地址，不能建立、移除或替换信任锚。
export function assertProfileTrustUnchanged(previous: RemoteProfile | undefined, next: RemoteProfile): void {
  const pins = (p: RemoteProfile | undefined): string[] => [...new Set(p?.endpoints.filter((e) => e.trustMode === 'pinned').map((e) => e.pin!.value) ?? [])].sort()
  if (JSON.stringify(pins(previous)) !== JSON.stringify(pins(next))) throw new Error('TLS 信任锚变化，请在电脑重新扫码')
  if (pins(previous).length) {
    const trusted = new Set(previous?.endpoints.filter((e) => e.scope === 'public' && e.trustMode !== 'pinned').map((e) => new URL(e.url).hostname) ?? [])
    if (next.endpoints.some((e) => e.scope === 'public' && e.trustMode !== 'pinned' && !trusted.has(new URL(e.url).hostname))) throw new Error('网络不能新增未扫码绑定的公网信任模式')
  }
  if (previous && previous.deviceId !== next.deviceId && !previous.deviceId.startsWith('legacy-')) throw new Error('设备身份变化')
}
export function parseRemoteProfile(input: unknown): RemoteProfile { return profile(record(input, PROFILE_KEYS)) }
/**
 * 精简配对二维码（v2）：只放配对必需字段，避免多端点/pin 把二维码撑到几十行列。
 * 字段：v=2、d=deviceId、h=host:port、c=pairingCode、x=过期时间（Unix 秒）。
 */
export interface CompactPairingQr { v: 2; d: string; h: string; c: string; x: number }
const COMPACT_QR_KEYS = ['v', 'd', 'h', 'c', 'x']
function compactHost(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || /[\/?#@\s]/.test(value)) throw new Error('连接端点无效')
  let url: URL
  try { url = new URL(`ws://${value}/ws`) } catch { throw new Error('连接端点无效') }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || url.pathname !== '/ws' || url.search || url.username || url.password) throw new Error('连接端点无效')
  return url.host
}
export function createCompactPairingQr(profile: RemoteProfile, pairingCode: string, expiresAt: number): CompactPairingQr {
  const endpoint = profile.endpoints.find((e) => e.scope === 'lan' && e.url.startsWith('ws://'))
  if (!endpoint) throw new Error('缺少局域网端点')
  const url = new URL(endpoint.url)
  if (!url.port || url.pathname !== '/ws' || url.search || url.username || url.password) throw new Error('连接端点无效')
  if (!/^[a-f0-9]{64}$/.test(pairingCode)) throw new Error('配对码无效')
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('配对码已过期')
  return { v: 2, d: profile.deviceId, h: url.host, c: pairingCode, x: Math.floor(expiresAt / 1000) }
}
export function parseCompactPairingQr(input: unknown, now = Date.now()): PairingQr {
  const p = record(input, COMPACT_QR_KEYS)
  if (p.v !== 2 || typeof p.d !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(p.d) ||
    typeof p.c !== 'string' || !/^[a-f0-9]{64}$/.test(p.c) ||
    typeof p.x !== 'number' || !Number.isSafeInteger(p.x) || p.x <= 0) throw new Error('二维码无效')
  const host = compactHost(p.h)
  const expiresAt = p.x * 1000
  const issuedAt = expiresAt - PAIRING_TTL_MS
  if (issuedAt > now + 30_000) throw new Error('二维码无效')
  if (expiresAt <= now) throw new Error('二维码已过期，请在电脑刷新')
  const endpoint = validateEndpoint({ url: `ws://${host}/ws`, scope: 'lan' })
  return {
    schemaVersion: 1,
    deviceId: p.d,
    deviceName: '电脑',
    updatedAt: issuedAt,
    endpoints: [endpoint],
    kind: 'profer-pairing',
    pairingCode: p.c,
    issuedAt,
    expiresAt,
  }
}
/**
 * 精简配对二维码（v3）：在 v2 的基础上再带一组公网端点，供用户自建 FRP/端口映射后扫码直连。
 * 字段：v=3、d=deviceId、h=局域网 host:port、p=公网 host:port、k=公网自签证书 SPKI pin（仅 IP 公网端点）、
 * c=pairingCode、x=过期时间（Unix 秒）。
 *
 * 公网端点的信任模式由 p 的主机形态决定：IP 必须带 pin（自签 TLS），域名必须不带 pin（系统可信证书）。
 */
export interface CompactPairingQrV3 { v: 3; d: string; h: string; p: string; k?: string; c: string; x: number }
const COMPACT_QR_V3_KEYS = ['v', 'd', 'h', 'p', 'k', 'c', 'x']
const PIN_VALUE = /^sha256\/[A-Za-z0-9+/]{43}=$/
function compactHostname(value: string): string {
  let url: URL
  try { url = new URL(`wss://${value}/ws`) } catch { throw new Error('连接端点无效') }
  return url.hostname.replace(/^\[|\]$/g, '')
}
function isIpHost(host: string): boolean { return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') }
export function createCompactPairingQrV3(profile: RemoteProfile, pairingCode: string, expiresAt: number): CompactPairingQrV3 {
  const lan = profile.endpoints.find((e) => e.scope === 'lan' && e.url.startsWith('ws://'))
  const pub = profile.endpoints.find((e) => e.scope === 'public')
  if (!lan) throw new Error('缺少局域网端点')
  if (!pub) throw new Error('缺少公网端点')
  const lanUrl = new URL(lan.url)
  const pubUrl = new URL(pub.url)
  if (!lanUrl.port || lanUrl.pathname !== '/ws' || lanUrl.search || lanUrl.username || lanUrl.password) throw new Error('连接端点无效')
  if (!pubUrl.port && pubUrl.protocol !== 'wss:') throw new Error('连接端点无效')
  if (pubUrl.pathname !== '/ws' || pubUrl.search || pubUrl.username || pubUrl.password || pubUrl.protocol !== 'wss:') throw new Error('连接端点无效')
  if (!/^[a-f0-9]{64}$/.test(pairingCode)) throw new Error('配对码无效')
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('配对码已过期')
  // wss 的 443 会被 URL 规范化掉，但二维码里必须显式带端口，解析端才能统一按 host:port 处理。
  const pubHost = `${pubUrl.hostname}:${pubUrl.port || '443'}`
  const base = { v: 3 as const, d: profile.deviceId, h: lanUrl.host, p: pubHost, c: pairingCode, x: Math.floor(expiresAt / 1000) }
  if (pub.trustMode === 'pinned') {
    if (!pub.pin || !PIN_VALUE.test(pub.pin.value)) throw new Error('pin 无效')
    return { ...base, k: pub.pin.value }
  }
  return base
}
export function parseCompactPairingQrV3(input: unknown, now = Date.now()): PairingQr {
  const p = record(input, COMPACT_QR_V3_KEYS)
  if (p.v !== 3 || typeof p.d !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(p.d) ||
    typeof p.c !== 'string' || !/^[a-f0-9]{64}$/.test(p.c) ||
    typeof p.x !== 'number' || !Number.isSafeInteger(p.x) || p.x <= 0 || p.x > 9_007_199_254_740) throw new Error('二维码无效')
  const lanHost = compactHost(p.h)
  const pubHost = compactHost(p.p)
  const expiresAt = p.x * 1000
  const issuedAt = expiresAt - PAIRING_TTL_MS
  if (issuedAt > now + 30_000) throw new Error('二维码无效')
  if (expiresAt <= now) throw new Error('二维码已过期，请在电脑刷新')
  const lanEndpoint = validateEndpoint({ url: `ws://${lanHost}/ws`, scope: 'lan' })
  const pubHostname = compactHostname(pubHost)
  const publicEndpoint = isIpHost(pubHostname)
    ? validateEndpoint({ url: `wss://${pubHost}/ws`, scope: 'public', trustMode: 'pinned', pin: { algorithm: 'spki-sha256', value: p.k } })
    : p.k === undefined
      ? validateEndpoint({ url: `wss://${pubHost}/ws`, scope: 'public', trustMode: 'system' })
      : (() => { throw new Error('域名公网端点不能携带 pin') })()
  return {
    schemaVersion: 2,
    deviceId: p.d,
    deviceName: '电脑',
    updatedAt: issuedAt,
    endpoints: [lanEndpoint, publicEndpoint],
    kind: 'profer-pairing',
    pairingCode: p.c,
    issuedAt,
    expiresAt,
  }
}
export function parsePairingQr(text: string, now = Date.now()): PairingQr {
  if (new TextEncoder().encode(text).length > 8192) throw new Error('二维码过大')
  let input: unknown
  try { input = JSON.parse(text) } catch { throw new Error('二维码损坏') }
  if (input && typeof input === 'object' && (input as { v?: unknown }).v === 3) return parseCompactPairingQrV3(input, now)
  if (input && typeof input === 'object' && (input as { v?: unknown }).v === 2) return parseCompactPairingQr(input, now)
  const p = record(input, QR_KEYS)
  const parsed = profile(p)
  if (p.kind !== 'profer-pairing' || typeof p.pairingCode !== 'string' || !/^[a-f0-9]{64}$/.test(p.pairingCode) || typeof p.issuedAt !== 'number' || typeof p.expiresAt !== 'number' || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt < 0 || p.expiresAt - p.issuedAt !== PAIRING_TTL_MS || p.issuedAt > now + 30_000) throw new Error('二维码无效')
  if (p.expiresAt <= now) throw new Error('二维码已过期，请在电脑刷新')
  return { ...parsed, kind: 'profer-pairing', pairingCode: p.pairingCode, issuedAt: p.issuedAt, expiresAt: p.expiresAt }
}
