import { createHash, createPrivateKey, createPublicKey, randomUUID, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { generate } from 'selfsigned'
import type { RemotePin } from '@profer/shared'
export interface TlsIdentity { cert: string; key: string; pin: RemotePin; publicIp: string }
interface StoredIdentity { version: 1; cert: string; encryptedKey: string; publicIp: string }
export function spkiPin(cert: X509Certificate): RemotePin { return { algorithm: 'spki-sha256', value: `sha256/${createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}` } }
export function validateTlsIdentity(certPem: string, keyPem: string, ip: string, now = Date.now()): TlsIdentity {
  const cert = new X509Certificate(certPem); const key = createPrivateKey(keyPem)
  if (!isIP(ip) || cert.ca || !cert.verify(cert.publicKey) || !cert.checkPrivateKey(key) || now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo) || !cert.checkIP(ip) || !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || cert.publicKey.asymmetricKeyType !== 'ec' || cert.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('TLS 身份损坏、过期或用途不符；请显式轮换并重新扫码')
  return { cert: certPem, key: keyPem, pin: spkiPin(cert), publicIp: ip }
}
// 私钥只保存系统安全存储密文，权限是第二层保护；不能依赖 Windows chmod 保护明文。
export class RemoteTlsStore {
  constructor(private directory: string, private protect: (key: string) => string, private reveal: (value: string) => string) {}
  load(): TlsIdentity | null {
    const file = join(this.directory, 'identity.json'); if (!existsSync(file)) { if (existsSync(join(this.directory, 'initialized'))) throw new Error('TLS 身份缺失，请显式轮换并重新扫码'); return null }
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('TLS 身份文件权限无效')
    try { const saved = JSON.parse(readFileSync(file, 'utf8')) as StoredIdentity; if (saved.version !== 1) throw new Error(); return validateTlsIdentity(saved.cert, this.reveal(saved.encryptedKey), saved.publicIp) }
    catch { throw new Error('TLS 身份损坏或过期，请显式轮换并重新扫码') }
  }
  async ensure(publicIp: string, rotate = false): Promise<TlsIdentity> {
    if (!isIP(publicIp)) throw new Error('公网 IP 无效')
    const previous = rotate ? null : this.load()
    if (previous?.publicIp === publicIp) return previous
    const keyPair = previous ? { privateKey: previous.key, publicKey: createPublicKey(previous.key).export({ type: 'spki', format: 'pem' }).toString() } : undefined
    const now = Date.now()
    const generated = await generate([{ name: 'commonName', value: 'Profer Remote' }], {
      keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: new Date(now - 300_000), notAfterDate: new Date(now + 365 * 86400_000),
      ...(keyPair ? { keyPair } : {}), extensions: [
        { name: 'basicConstraints', cA: false, critical: true }, { name: 'keyUsage', digitalSignature: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: publicIp }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: '::1' }] },
      ],
    })
    const identity = validateTlsIdentity(generated.cert, generated.private, publicIp)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); if (process.platform !== 'win32') chmodSync(this.directory, 0o700)
    const encryptedKey = this.protect(identity.key)
    const file = join(this.directory, 'identity.json'); const temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(join(this.directory, 'initialized'), '1', { mode: 0o600 })
    writeFileSync(temp, JSON.stringify({ version: 1, cert: identity.cert, encryptedKey, publicIp }), { mode: 0o600, flag: 'wx' }); renameSync(temp, file)
    return identity
  }
}
