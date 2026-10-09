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
export function parsePairingQr(text: string, now = Date.now()): PairingQr {
  if (new TextEncoder().encode(text).length > 8192) throw new Error('二维码过大')
  let input: unknown
  try { input = JSON.parse(text) } catch { throw new Error('二维码损坏') }
  const p = record(input, QR_KEYS)
  const parsed = profile(p)
  if (p.kind !== 'profer-pairing' || typeof p.pairingCode !== 'string' || !/^[a-f0-9]{64}$/.test(p.pairingCode) || typeof p.issuedAt !== 'number' || typeof p.expiresAt !== 'number' || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt < 0 || p.expiresAt - p.issuedAt !== PAIRING_TTL_MS || p.issuedAt > now + 30_000) throw new Error('二维码无效')
  if (p.expiresAt <= now) throw new Error('二维码已过期，请在电脑刷新')
  return { ...parsed, kind: 'profer-pairing', pairingCode: p.pairingCode, issuedAt: p.issuedAt, expiresAt: p.expiresAt }
}
