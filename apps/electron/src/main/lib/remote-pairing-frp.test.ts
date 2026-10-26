import { describe, expect, test } from 'bun:test'
import { PairingManager, createBinding, secretHash } from './remote-pairing'
import { createCompactPairingQr, createCompactPairingQrV3, parseCompactPairingQr, parseCompactPairingQrV3, parsePairingQr, parseRemoteProfile, validateEndpoint, type RemoteProfile } from '@profer/shared'
import { parse } from 'smol-toml'
import { createHash } from 'node:crypto'
import { deploymentFiles, renderDeploymentInstructions, renderFrpcToml, selectFrpAsset, validateArchiveEntry, validateFrpConfig, verifySha256, type FrpConfig, type FrpServerAsset } from './remote-frp-core'
const serverAssets: FrpServerAsset[] = [
  { arch: 'amd64', name: 'frp_0.71.0_linux_amd64.tar.gz', url: 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_amd64.tar.gz', sha256: 'a'.repeat(64) },
  { arch: 'arm64', name: 'frp_0.71.0_linux_arm64.tar.gz', url: 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_arm64.tar.gz', sha256: 'b'.repeat(64) },
  { arch: 'arm', name: 'frp_0.71.0_linux_arm.tar.gz', url: 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_arm.tar.gz', sha256: 'c'.repeat(64) },
]
const profile: RemoteProfile = { schemaVersion: 1, deviceId: 'desktop-123', deviceName: 'Desktop', updatedAt: 1, endpoints: [{ url: 'ws://192.168.1.2:7788/ws', scope: 'lan' }, { url: 'wss://remote.example.com/ws', scope: 'public' }] }
const config: FrpConfig = { serverAddr: '2001:db8::1', serverPort: 7000, remotePort: 17788, authToken: 'a"\\b=特殊字符', publicUrl: 'wss://remote.example.com/ws', startOnLaunch: false, serverVersion: '0.71.0', trustedCaFile: '/test/frp-control-ca.crt' }
describe('QR schema and single-use pairing', () => {
  test('5 minute expiry, refresh, concurrency and revocation', async () => {
    let now = 1000; const m = new PairingManager(() => now)
    const old = m.refresh(profile); const qr = m.refresh(profile)
    expect(qr.expiresAt - qr.issuedAt).toBe(300000)
    expect(parsePairingQr(JSON.stringify(qr), now)).toEqual(qr)
    expect(() => m.consume(old.pairingCode, 'old')).toThrow()
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => Promise.resolve().then(() => m.consume(qr.pairingCode, `peer${i}`))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const expired = m.refresh(profile); now = expired.expiresAt
    expect(() => m.consume(expired.pairingCode, 'expired')).toThrow()
    expect(() => parsePairingQr(JSON.stringify(expired), now)).toThrow('过期')
    const revoked = m.refresh(profile); m.revoke(); expect(() => m.consume(revoked.pairingCode, 'revoked')).toThrow()
  })
  test('invalid requests limited and secrets excluded from QR/errors/bindings', () => {
    const m = new PairingManager(() => 1000); const qr = m.refresh(profile)
    for (let i = 0; i < 5; i++) expect(() => m.consume('bad-secret', 'peer')).toThrow('无效')
    expect(() => m.consume(qr.pairingCode, 'peer')).toThrow('过多')
    const { credential, binding } = createBinding('Pocket'); expect(binding.tokenHash).toBe(secretHash(credential)); expect(JSON.stringify(binding)).not.toContain(credential)
    expect(JSON.stringify(qr)).not.toContain(credential)
    for (const invalid of ['{', 'x'.repeat(8193), JSON.stringify({ ...qr, schemaVersion: 2 }), JSON.stringify({ ...qr, token: credential }), JSON.stringify({ ...qr, pairingCode: 'bad' }), JSON.stringify({ ...qr, expiresAt: qr.expiresAt + 1 })]) expect(() => parsePairingQr(invalid, 1000)).toThrow()
  })
  test('strict profile/QR/endpoint reject unknown keys, aliases and non-plain objects; audit is redacted', () => {
    const m = new PairingManager(() => 1000); const qr = m.refresh(profile)
    for (const key of ['token', 'credential', 'authToken', 'secret', 'nested', '__proto__']) {
      const q = JSON.parse(JSON.stringify(qr)) as Record<string, unknown>; Object.defineProperty(q, key, { value: 'SECRET_TEST_VALUE', enumerable: true }); expect(() => parsePairingQr(JSON.stringify(q), 1000)).toThrow()
      const p = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>; Object.defineProperty(p, key, { value: 'SECRET_TEST_VALUE', enumerable: true }); expect(() => parseRemoteProfile(p)).toThrow()
      expect(() => validateEndpoint({ ...profile.endpoints[0], [key]: 'SECRET_TEST_VALUE' })).toThrow()
    }
    expect(() => parseRemoteProfile(new Date())).toThrow(); expect(() => parseRemoteProfile(Object.assign(Object.create({ inherited: true }), profile))).toThrow()
    for (let i = 0; i < 6; i++) { try { m.consume('SECRET_TEST_VALUE', '192.168.1.5') } catch { /* expected */ } }
    const events = m.getAudit(); expect(events.filter((e) => e.kind === 'rate_limited')).toHaveLength(1); expect(events[0]?.at).toBe(1000)
    const output = JSON.stringify(events); expect(output).not.toContain('SECRET_TEST_VALUE'); expect(output).not.toContain(qr.pairingCode); expect(output).not.toContain('192.168.1.5')
  })
  test('public plaintext/query/secrets/path/device data refused', () => {
    for (const url of ['ws://remote.example.com/ws', 'wss://remote.example.com/ws?token=x', 'wss://a:b@remote.example.com/ws', 'wss://remote.example.com/other']) expect(() => validateEndpoint({ url, scope: 'public' })).toThrow()
    expect(() => validateEndpoint({ url: 'ws://169.254.1.2/ws', scope: 'lan' })).toThrow()
    expect(() => parseRemoteProfile({ ...profile, endpoints: [...profile.endpoints, profile.endpoints[0]] })).toThrow('重复')
    expect(() => parseRemoteProfile({ ...profile, deviceId: '!' })).toThrow()
  })
})
describe('compact pairing QR', () => {
  test('roundtrips required fields and stays small', () => {
    const now = Date.now(); const m = new PairingManager(() => now); const qr = m.refresh(profile)
    const compact = createCompactPairingQr(profile, qr.pairingCode, now + 300000)
    expect(JSON.stringify(compact).length).toBeLessThan(200)
    const parsed = parseCompactPairingQr(compact, now)
    expect(parsed.deviceId).toBe(profile.deviceId)
    expect(parsed.endpoints).toEqual([{ url: 'ws://192.168.1.2:7788/ws', scope: 'lan' }])
    expect(parsed.pairingCode).toBe(qr.pairingCode)
    expect(parsePairingQr(JSON.stringify(compact), now).pairingCode).toBe(qr.pairingCode)
  })
  test('rejects bad host, code, expiry and unknown keys', () => {
    const now = Date.now(); const m = new PairingManager(() => now); const code = m.refresh(profile).pairingCode
    const base = createCompactPairingQr(profile, code, now + 300000)
    for (const h of ['', '192.168.1.2', 'ws://192.168.1.2:7788', '192.168.1.2:7788/ws', 'remote.example.com:7788', '192.168.1.2:0']) {
      expect(() => parseCompactPairingQr({ ...base, h }, now)).toThrow()
    }
    expect(() => parseCompactPairingQr({ ...base, c: 'bad' }, now)).toThrow()
    expect(() => parseCompactPairingQr({ ...base, x: Math.floor(now / 1000) - 1 }, now)).toThrow('过期')
    expect(() => parseCompactPairingQr({ ...base, x: Math.floor(now / 1000) + 400 }, now)).toThrow()
    expect(() => parseCompactPairingQr({ ...base, token: 'SECRET' }, now)).toThrow()
    expect(() => parseCompactPairingQr({ ...base, v: 1 }, now)).toThrow()
  })
})
describe('FRP configuration, official assets and deployment', () => {
  test('structured TOML roundtrips quotes/backslash/Unicode and IPv6', () => {
    const toml = parse(renderFrpcToml(config, 7788))
    expect(toml.serverAddr).toBe('2001:db8::1'); expect(toml.auth).toEqual({ method: 'token', token: config.authToken })
    expect(toml.proxies).toEqual([{ name: 'profer-remote', type: 'tcp', localIP: '127.0.0.1', localPort: 7788, remotePort: 17788 }])
    for (const value of [0, 1023, 65536, 7000.5]) expect(() => validateFrpConfig({ ...config, serverPort: value })).toThrow()
    for (const addr of ['', 'host\nkey=1', 'host:7000']) expect(() => validateFrpConfig({ ...config, serverAddr: addr })).toThrow()
    expect(() => validateFrpConfig({ ...config, publicUrl: 'ws://example.com/ws' })).toThrow()
  })
  test('exact official OS/CPU asset, stable release, SHA256 mismatch', () => {
    const data = Buffer.from('binary'); const digest = createHash('sha256').update(data).digest('hex')
    const release = { tag_name: 'v0.71.0', draft: false, prerelease: false, assets: ['windows_amd64.zip', 'darwin_arm64.tar.gz', 'linux_amd64.tar.gz'].map((s) => ({ name: `frp_0.71.0_${s}`, browser_download_url: `https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_${s}`, digest: `sha256:${digest}`, size: data.length })) }
    expect(selectFrpAsset(release, 'win32', 'x64').binary).toBe('frpc.exe')
    expect(selectFrpAsset(release, 'darwin', 'arm64').binary).toBe('frpc')
    expect(selectFrpAsset(release, 'linux', 'x64').root).toBe('frp_0.71.0_linux_amd64')
    for (const r of [{ ...release, prerelease: true }, { ...release, assets: [] }, { ...release, assets: release.assets.map((a) => ({ ...a, digest: undefined })) }]) expect(() => selectFrpAsset(r, 'win32', 'x64')).toThrow()
    verifySha256(data, digest); expect(() => verifySha256(data, '0'.repeat(64))).toThrow('SHA256')
    for (const [name, type, size] of [['../frpc', 'File', 1], ['/root/frpc', 'File', 1], ['C:/frpc', 'File', 1], ['a\\frpc', 'File', 1], ['a/frpc', 'SymbolicLink', 1], ['a/frpc', 'Link', 1], ['a/frpc', 'File', 65 * 1024 * 1024]] as const) expect(() => validateArchiveEntry(name, type, size)).toThrow()
  })
  test('deploy templates parse, independent secrets, loopback mapping and trusted WSS', () => {
    const material = { caCert: 'CA_CERT_PEM', caKey: 'CA_KEY_PEM', serverCert: 'SERVER_CERT_PEM', serverKey: 'SERVER_KEY_PEM' }
    const files = deploymentFiles(config, material, serverAssets); const frps = parse(files['frps.toml']!)
    expect(frps.proxyBindAddr).toBe('127.0.0.1'); expect(frps.allowPorts).toEqual([{ start: 17788, end: 17788 }]); expect(frps.auth).toEqual({ method: 'token', token: config.authToken })
    expect(files['frps.service']).toContain('User=frp'); expect(files['README.md']).toContain('443/TCP'); expect(files['README.md']).toContain('7000/TCP'); expect(files['Caddyfile']).toContain('reverse_proxy 127.0.0.1:17788')
    // 2026-10-06 确认：导出必然包含 Profer 生成的真实 Token/控制密钥，不再只导出占位符。
    expect(frps.auth).toEqual({ method: 'token', token: config.authToken })
    expect(Object.values(files).join('')).not.toContain('REPLACE_WITH_INDEPENDENT_FRP_TOKEN')
    expect(files['ca.key']).toBe(material.caKey); expect(files['server.key']).toBe(material.serverKey)
    expect(renderDeploymentInstructions(config, material, serverAssets)).toBe(files['deploy.sh']!)
    // 服务端一条命令自举：不再要求用户预先准备 frps 二进制
    expect(files['deploy.sh']).not.toContain('请先核验官方 SHA256')
    expect(files['README.md']).not.toContain('1. 安装官方 frps')
    expect(files['README.md']).toContain('不需要你预先准备 frps 二进制')
    expect(files['README.md']).toContain('bash deploy.sh')
  })
})
describe('public endpoint compact QR (v3)', () => {
  const pin = { algorithm: 'spki-sha256' as const, value: `sha256/${'A'.repeat(43)}=` }
  const lan = { url: 'ws://192.168.1.2:7788/ws', scope: 'lan' as const }
  const pinnedProfile: RemoteProfile = { schemaVersion: 2, deviceId: 'desktop-123', deviceName: 'Desktop', updatedAt: 1, endpoints: [lan, { url: 'wss://203.0.113.7:17788/ws', scope: 'public', trustMode: 'pinned', pin }] }
  const domainProfile: RemoteProfile = { schemaVersion: 2, deviceId: 'desktop-123', deviceName: 'Desktop', updatedAt: 1, endpoints: [lan, { url: 'wss://remote.example.com:443/ws', scope: 'public', trustMode: 'system' }] }
  const now = Date.now()

  test('pinned public endpoint roundtrips with pin and stays scannable', () => {
    const code = 'a'.repeat(64)
    const qr = createCompactPairingQrV3(pinnedProfile, code, now + 300000)
    expect(qr.v).toBe(3); expect(qr.p).toBe('203.0.113.7:17788'); expect(qr.k).toBe(pin.value)
    expect(JSON.stringify(qr).length).toBeLessThan(400)
    const parsed = parseCompactPairingQrV3(qr, now)
    expect(parsed.endpoints).toEqual([lan, { url: 'wss://203.0.113.7:17788/ws', scope: 'public', trustMode: 'pinned', pin }])
    expect(parsed.pairingCode).toBe(code)
    expect(parsePairingQr(JSON.stringify(qr), now).endpoints).toHaveLength(2)
  })

  test('domain public endpoint uses system trust without pin', () => {
    const qr = createCompactPairingQrV3(domainProfile, 'b'.repeat(64), now + 300000)
    expect(qr.k).toBeUndefined(); expect(qr.p).toBe('remote.example.com:443')
    const parsed = parseCompactPairingQrV3(qr, now)
    expect(parsed.endpoints[1]).toEqual({ url: 'wss://remote.example.com/ws', scope: 'public', trustMode: 'system' })
  })

  test('rejects plaintext, missing/extra pin, unknown keys and expired codes', () => {
    const qr = createCompactPairingQrV3(pinnedProfile, 'c'.repeat(64), now + 300000)
    const { k: _pin, ...withoutPin } = qr
    expect(() => parseCompactPairingQrV3(withoutPin, now)).toThrow()
    expect(() => parseCompactPairingQrV3({ ...qr, p: '203.0.113.7:0' }, now)).toThrow()
    expect(() => parseCompactPairingQrV3({ ...qr, k: 'sha256/bad' }, now)).toThrow()
    expect(() => parseCompactPairingQrV3({ ...qr, extra: 'SECRET' }, now)).toThrow()
    expect(() => parseCompactPairingQrV3({ ...qr, h: 'remote.example.com:7788' }, now)).toThrow()
    expect(() => parseCompactPairingQrV3({ ...qr, x: Math.floor(now / 1000) - 1 }, now)).toThrow('过期')
    expect(() => createCompactPairingQrV3(domainProfile, 'd'.repeat(64), now + 300000)).not.toThrow()
    // 域名端点带 pin 属于混淆输入，直接拒绝。
    const domainQr = createCompactPairingQrV3(domainProfile, 'e'.repeat(64), now + 300000)
    expect(() => parseCompactPairingQrV3({ ...domainQr, k: pin.value }, now)).toThrow('不能携带 pin')
    // 缺少公网端点时不能发 v3，调用方应退回 v2。
    expect(() => createCompactPairingQrV3({ ...domainProfile, endpoints: [lan] }, 'f'.repeat(64), now + 300000)).toThrow('缺少公网端点')
    expect(createCompactPairingQr({ ...domainProfile, endpoints: [lan] }, 'f'.repeat(64), now + 300000).v).toBe(2)
  })
})
