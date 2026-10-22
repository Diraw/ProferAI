import { createPrivateKey, createPublicKey, randomUUID, X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { generate } from 'selfsigned'

// Profer 托管的 FRP 控制链路材料：本地 CA + frps server 证书。
// 用户只填公网 IP/域名与端口，CA/server 证书由这里生成、持久化并供 frpc 作为信任锚使用。
// 私钥以系统安全存储密文落盘；ca.crt 明文落盘以便 frpc 读取 trustedCaFile。
const HOST_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/
const SERVER_AUTH_EKU = '1.3.6.1.5.5.7.3.1'
const CA_DAYS = 3650
const SERVER_DAYS = 825

export interface FrpControlMaterial {
  serverAddr: string
  caCert: string
  caKey: string
  serverCert: string
  serverKey: string
  caCertPath: string
}

interface StoredControl {
  version: 1
  serverAddr: string
  caCert: string
  encryptedCaKey: string
  serverCert: string
  encryptedServerKey: string
}

export function assertFrpServerAddr(addr: string): string {
  const value = addr.trim()
  if (!value || (isIP(value) === 0 && !HOST_RE.test(value))) throw new Error('FRP 服务器地址格式无效')
  return value
}

function assertEcP256(cert: X509Certificate, label: string): void {
  if (cert.publicKey.asymmetricKeyType !== 'ec' || cert.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error(`${label}算法不符`)
}

function sanEntries(cert: X509Certificate): Array<{ type: 'ip' | 'dns'; value: string }> {
  return (cert.subjectAltName ?? '')
    .split(/,\s*/)
    .filter(Boolean)
    .map((entry) => (entry.startsWith('IP Address:')
      ? { type: 'ip' as const, value: entry.slice('IP Address:'.length) }
      : { type: 'dns' as const, value: entry.replace(/^DNS:/, '') }))
}

/**
 * 严格校验 Profer 托管材料：CA 链、serverAuth 用途、有效期、算法与唯一的 SAN。
 * 校验是 frps 身份验证的本地信任锚，不允许因“自动生成”而放宽。
 */
export function validateControlMaterial(serverAddr: string, caCert: string, caKey: string, serverCert: string, serverKey: string, now = Date.now()): void {
  const addr = assertFrpServerAddr(serverAddr)
  let ca: X509Certificate
  try { ca = new X509Certificate(caCert) } catch { throw new Error('FRP 控制 CA 损坏') }
  if (!ca.ca) throw new Error('FRP 控制 CA 不是 CA 证书')
  if (!ca.checkPrivateKey(createPrivateKey(caKey))) throw new Error('FRP 控制 CA 私钥不匹配')
  assertEcP256(ca, 'FRP 控制 CA ')
  if (now < Date.parse(ca.validFrom) || now >= Date.parse(ca.validTo)) throw new Error('FRP 控制 CA 已过期')
  let server: X509Certificate
  try { server = new X509Certificate(serverCert) } catch { throw new Error('FRP server 证书损坏') }
  if (server.ca) throw new Error('FRP server 证书不能是 CA')
  if (!server.checkPrivateKey(createPrivateKey(serverKey))) throw new Error('FRP server 私钥不匹配')
  if (!server.verify(ca.publicKey)) throw new Error('FRP server 证书不是由本地控制 CA 签发')
  if (!server.keyUsage?.includes(SERVER_AUTH_EKU)) throw new Error('FRP server 证书用途不是 serverAuth')
  assertEcP256(server, 'FRP server 证书 ')
  if (now < Date.parse(server.validFrom) || now >= Date.parse(server.validTo)) throw new Error('FRP server 证书已过期')
  const entries = sanEntries(server)
  if (entries.length !== 1) throw new Error('FRP server 证书 SAN 必须唯一匹配服务器地址')
  if (isIP(addr) !== 0) {
    if (entries[0]!.type !== 'ip' || !server.checkIP(addr)) throw new Error('FRP server 证书 IP SAN 与服务器地址不匹配')
  } else if (entries[0]!.type !== 'dns' || !server.checkHost(addr)) {
    throw new Error('FRP server 证书 DNS SAN 与服务器地址不匹配')
  }
}

async function generateCa(): Promise<{ cert: string; key: string }> {
  const now = Date.now()
  const result = await generate([{ name: 'commonName', value: 'Profer FRP Control CA' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    notBeforeDate: new Date(now - 300_000), notAfterDate: new Date(now + CA_DAYS * 86400_000),
    extensions: [{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }],
  })
  return { cert: result.cert, key: result.private }
}

async function generateServerCert(addr: string, ca: { cert: string; key: string }, existingKey?: string): Promise<{ cert: string; key: string }> {
  const now = Date.now()
  const keyPair = existingKey
    ? { privateKey: existingKey, publicKey: createPublicKey(existingKey).export({ type: 'spki', format: 'pem' }).toString() }
    : undefined
  const result = await generate([{ name: 'commonName', value: 'Profer FRP Control' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    notBeforeDate: new Date(now - 300_000), notAfterDate: new Date(now + SERVER_DAYS * 86400_000),
    ...(keyPair ? { keyPair } : {}),
    ca: { key: ca.key, cert: ca.cert },
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: isIP(addr) !== 0 ? [{ type: 7, ip: addr }] : [{ type: 2, value: addr }] },
    ],
  })
  return { cert: result.cert, key: result.private }
}

/**
 * 控制材料持久化。缺失 → 首次生成；地址变化 → 复用 CA 与 server 私钥重签 SAN；
 * 显式 rotate → 全新 CA 与私钥；损坏/权限异常 → fail closed，不静默替换。
 */
export class FrpControlStore {
  constructor(private directory: string, private protect: (value: string) => string, private reveal: (value: string) => string) {}

  get caCertPath(): string { return join(this.directory, 'ca.crt') }
  private get controlFile(): string { return join(this.directory, 'control.json') }
  private get markerFile(): string { return join(this.directory, 'initialized') }

  hasMaterial(): boolean { return existsSync(this.controlFile) }

  load(): FrpControlMaterial | null {
    if (!existsSync(this.controlFile)) {
      if (existsSync(this.markerFile)) throw new Error('FRP 控制身份缺失，请重新生成配置')
      return null
    }
    const stat = lstatSync(this.controlFile)
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('FRP 控制身份文件权限无效')
    try {
      const saved = JSON.parse(readFileSync(this.controlFile, 'utf8')) as StoredControl
      if (saved.version !== 1) throw new Error('版本不符')
      const caKey = this.reveal(saved.encryptedCaKey)
      const serverKey = this.reveal(saved.encryptedServerKey)
      validateControlMaterial(saved.serverAddr, saved.caCert, caKey, saved.serverCert, serverKey)
      if (!existsSync(this.caCertPath) || readFileSync(this.caCertPath, 'utf8') !== saved.caCert) throw new Error('CA 文件状态不符')
      return { serverAddr: saved.serverAddr, caCert: saved.caCert, caKey, serverCert: saved.serverCert, serverKey, caCertPath: this.caCertPath }
    } catch {
      throw new Error('FRP 控制身份损坏或过期，请重新生成配置')
    }
  }

  async ensure(serverAddr: string, rotate = false): Promise<FrpControlMaterial> {
    const addr = assertFrpServerAddr(serverAddr)
    const previous = rotate ? null : this.load()
    if (previous && previous.serverAddr === addr) return previous
    const ca = previous ? { cert: previous.caCert, key: previous.caKey } : await generateCa()
    const server = await generateServerCert(addr, ca, previous?.serverKey)
    validateControlMaterial(addr, ca.cert, ca.key, server.cert, server.key)
    this.persist(addr, ca, server)
    return { serverAddr: addr, caCert: ca.cert, caKey: ca.key, serverCert: server.cert, serverKey: server.key, caCertPath: this.caCertPath }
  }

  private persist(addr: string, ca: { cert: string; key: string }, server: { cert: string; key: string }): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700)
    const payload: StoredControl = {
      version: 1, serverAddr: addr, caCert: ca.cert, encryptedCaKey: this.protect(ca.key),
      serverCert: server.cert, encryptedServerKey: this.protect(server.key),
    }
    const temp = `${this.controlFile}.${randomUUID()}.tmp`
    writeFileSync(this.caCertPath, ca.cert, { mode: 0o600 })
    writeFileSync(this.markerFile, '1', { mode: 0o600 })
    writeFileSync(temp, JSON.stringify(payload), { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.controlFile)
    if (process.platform !== 'win32') { chmodSync(this.controlFile, 0o600); chmodSync(this.caCertPath, 0o600); chmodSync(this.markerFile, 0o600) }
  }
}
