import { test, expect } from 'bun:test'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkServerIdentity, connect as tlsConnect, createServer, type ConnectionOptions, type PeerCertificate, type Server } from 'node:tls'
import { FrpControlStore, validateControlMaterial } from './remote-frp-control-identity'
const protect = (value: string): string => Buffer.from(value).reverse().toString('base64')
const reveal = (value: string): string => Buffer.from(value, 'base64').reverse().toString()
const spki = (pem: string): string => createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
function temp(): string { return mkdtempSync(join(tmpdir(), 'profer-frp-control-')) }
test('Profer generates CA and serverAuth frps certificate with matching IP/DNS SAN, encrypted at rest', async () => {
  const dir = temp()
  try {
    const store = new FrpControlStore(dir, protect, reveal)
    for (const addr of ['192.0.2.1', '2001:db8::1', 'frp.example.com']) {
      const material = await store.ensure(addr)
      validateControlMaterial(addr, material.caCert, material.caKey, material.serverCert, material.serverKey)
      const ca = new X509Certificate(material.caCert)
      const server = new X509Certificate(material.serverCert)
      expect(ca.ca).toBe(true)
      expect(ca.verify(ca.publicKey)).toBe(true)
      expect(server.ca).toBe(false)
      expect(server.verify(ca.publicKey)).toBe(true)
      expect(server.keyUsage).toContain('1.3.6.1.5.5.7.3.1')
      expect(server.publicKey.asymmetricKeyType).toBe('ec')
      expect(material.caCertPath).toBe(join(dir, 'ca.crt'))
      expect(existsSync(material.caCertPath)).toBe(true)
      expect(readFileSync(material.caCertPath, 'utf8')).toBe(material.caCert)
      // SAN 唯一且匹配该地址
      expect(server.subjectAltName).toContain(addr.includes(':') ? 'IP Address' : addr.includes('example') ? `DNS:${addr}` : `IP Address:${addr}`)
    }
    // 私钥不以明文落盘：只能经 protect/reveal 还原
    const stored = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')) as { encryptedCaKey: string; encryptedServerKey: string }
    expect(readFileSync(join(dir, 'control.json'), 'utf8')).not.toContain('PRIVATE KEY')
    expect(reveal(stored.encryptedCaKey)).toContain('PRIVATE KEY')
    expect(reveal(stored.encryptedServerKey)).toContain('PRIVATE KEY')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('repeated generation is idempotent; address change reuses CA and server key and only reissues SAN; explicit rotate replaces both', async () => {
  const dir = temp()
  try {
    const store = new FrpControlStore(dir, protect, reveal)
    const first = await store.ensure('192.0.2.1')
    const rawControl = readFileSync(join(dir, 'control.json'), 'utf8')
    expect(await store.ensure('192.0.2.1')).toEqual(first)
    expect(readFileSync(join(dir, 'control.json'), 'utf8')).toBe(rawControl)
    const moved = await store.ensure('2001:db8::1')
    expect(moved.caCert).toBe(first.caCert)
    expect(moved.caKey).toBe(first.caKey)
    expect(moved.serverKey).toBe(first.serverKey)
    expect(spki(moved.serverCert)).toBe(spki(first.serverCert))
    expect(moved.serverCert).not.toBe(first.serverCert)
    expect(new X509Certificate(moved.serverCert).checkIP('2001:db8::1')).toBe('2001:db8::1')
    const rotated = await store.ensure('2001:db8::1', true)
    expect(rotated.caCert).not.toBe(first.caCert)
    expect(rotated.serverKey).not.toBe(first.serverKey)
    expect(spki(rotated.serverCert)).not.toBe(spki(first.serverCert))
    const fresh = new FrpControlStore(dir, protect, reveal).load()!
    expect(fresh.caCert).toBe(rotated.caCert)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('validation rejects wrong CA chain, mismatched SAN, wrong key, wrong purpose and expiry', async () => {
  const dir = temp()
  try {
    const material = await new FrpControlStore(join(dir, 'a'), protect, reveal).ensure('192.0.2.1')
    const other = await new FrpControlStore(join(dir, 'b'), protect, reveal).ensure('192.0.2.1')
    expect(() => validateControlMaterial('192.0.2.1', material.caCert, material.caKey, other.serverCert, other.serverKey)).toThrow('签发')
    expect(() => validateControlMaterial('192.0.2.2', material.caCert, material.caKey, material.serverCert, material.serverKey)).toThrow('SAN')
    expect(() => validateControlMaterial('192.0.2.1', material.caCert, other.caKey, material.serverCert, material.serverKey)).toThrow('私钥')
    expect(() => validateControlMaterial('192.0.2.1', material.caCert, material.caKey, material.serverCert, material.serverKey, Date.now() + 900 * 86400_000)).toThrow('过期')
    expect(() => validateControlMaterial('192.0.2.1', material.caCert, material.caKey, material.caCert, material.caKey)).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('generated material completes real TLS verification (CA chain + SAN) and rejects missing anchor or wrong identity', async () => {
  const dir = temp()
  const servers: Server[] = []
  const attempt = (options: ConnectionOptions): Promise<string> => new Promise<string>((resolve) => {
    const socket = tlsConnect(options, () => { resolve('verified'); socket.destroy() })
    socket.on('error', (error: NodeJS.ErrnoException) => { resolve(`rejected:${error.code ?? error.message}`); socket.destroy() })
    socket.setTimeout(5000, () => { resolve('timeout'); socket.destroy() })
  })
  try {
    for (const addr of ['frp.example.com', '192.0.2.1', '2001:db8::1']) {
      const material = await new FrpControlStore(join(dir, addr.replace(/[^a-z0-9]/gi, '_')), protect, reveal).ensure(addr)
      const server = createServer({ key: material.serverKey, cert: material.serverCert, minVersion: 'TLSv1.2' })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      // 复刻 frpc(Go)：信任锚 = Profer 本地 CA，身份 = serverAddr（IP 也按 IP SAN 校验）
      const identity = (_host: string, cert: PeerCertificate): Error | undefined => checkServerIdentity(addr, cert)
      expect(await attempt({ host: '127.0.0.1', port, ca: material.caCert, checkServerIdentity: identity })).toBe('verified')
      expect(await attempt({ host: '127.0.0.1', port, checkServerIdentity: identity })).toContain('rejected')
      const wrong = addr === '192.0.2.1' ? '192.0.2.9' : 'wrong.example.com'
      expect(await attempt({ host: '127.0.0.1', port, ca: material.caCert, checkServerIdentity: (_host, cert) => checkServerIdentity(wrong, cert) })).toContain('rejected')
    }
  } finally { for (const server of servers) server.close(); rmSync(dir, { recursive: true, force: true }) }
})
test('damaged or removed material fails closed instead of silently regenerating; explicit rotate recovers', async () => {
  const dir = temp()
  try {
    const store = new FrpControlStore(dir, protect, reveal)
    const first = await store.ensure('192.0.2.1')
    writeFileSync(first.caCertPath, 'not-a-cert')
    await expect(store.ensure('192.0.2.1')).rejects.toThrow('重新生成')
    writeFileSync(first.caCertPath, first.caCert)
    writeFileSync(join(dir, 'control.json'), '{bad')
    await expect(store.ensure('192.0.2.1')).rejects.toThrow('重新生成')
    rmSync(join(dir, 'control.json'))
    await expect(store.ensure('192.0.2.1')).rejects.toThrow('缺失')
    const recovered = await store.ensure('192.0.2.1', true)
    expect(recovered.caCert).not.toBe(first.caCert)
    expect(new FrpControlStore(dir, protect, reveal).load()!.serverCert).toBe(recovered.serverCert)
    expect(() => validateControlMaterial('192.0.2.1', first.caCert, first.caKey, recovered.serverCert, recovered.serverKey)).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
