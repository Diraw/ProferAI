import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createHash, X509Certificate } from 'node:crypto'
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const WebSocket = require('ws')
const root = mkdtempSync(join(tmpdir(), 'profer-node-production-tls-'))
const before = { config: process.env.PROFER_CONFIG_DIR, sdk: process.env.CLAUDE_CONFIG_DIR, port: process.env.PROFER_REMOTE_PORT }
process.env.PROFER_CONFIG_DIR = root; process.env.CLAUDE_CONFIG_DIR = join(root, 'sdk')
const app = new EventEmitter(); app.getPath = () => root; app.getVersion = () => 'test'; app.isPackaged = false
const electron = { app, BrowserWindow: { getAllWindows: () => [] }, safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).reverse(), decryptString: b => Buffer.from(b).reverse().toString() }, ipcMain: { on() {}, handle() {} }, nativeTheme: new EventEmitter(), shell: {}, protocol: {}, net: {}, screen: {} }
const originalLoad = Module._load
Module._load = function (id, ...args) { return id === 'electron' ? electron : originalLoad.call(this, id, ...args) }
let target = 0
const bundle = join(root, 'remote-service.cjs')
await build({ entryPoints: [resolve(import.meta.dirname, 'remote-service.ts')], outfile: bundle, platform: 'node', format: 'cjs', bundle: true, nodePaths: [resolve(import.meta.dirname, '../../../node_modules')], external: ['electron', '@anthropic-ai/claude-agent-sdk', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai'], plugins: [{ name: 'isolated-frp', setup(builder) { builder.onResolve({ filter: /^qrcode$/ }, () => ({ path: 'qrcode', namespace: 'isolated-qr' })); builder.onLoad({ filter: /.*/, namespace: 'isolated-qr' }, () => ({ contents: `export default { toDataURL: async text => { globalThis.__isolatedPairingManager = JSON.parse(text); return 'isolated-qr'; } };`, loader: 'js' })); builder.onResolve({ filter: /remote-frp-service$/ }, () => ({ path: 'frp', namespace: 'isolated' })); builder.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({ contents: `let running = false; export const getFrpStatus = () => ({ running }); export const getFrpConfig = () => ({ serverAddr: '192.0.2.1', serverPort: 7000, remotePort: 17788, authToken: 'INDEPENDENT_TEST_TOKEN', publicUrl: '', trustedCaFile: 'test-control-ca.crt', serverVersion: '0.71.0', startOnLaunch: false, publicMode: 'pinned' }); export const getFrpPublicEndpoint = (pin, ip) => running && pin && ip === '192.0.2.1' ? { url: 'wss://192.0.2.1:17788/ws', scope: 'public', trustMode: 'pinned', pin } : undefined; export const startFrp = async port => { globalThis.__isolatedTlsPort = port; running = true; return { running }; }; export const stopFrp = async () => { running = false; }; export const startFrpIfConfigured = async () => {}; export const ensureFrpReady = async () => getFrpConfig();`, loader: 'js' })); } }] })
const remote = require(bundle)
const sockets = new Set()
function connect(cert) {
  const ws = new WebSocket(`wss://127.0.0.1:${target}/ws`, 'profer.remote.v1', { ca: cert, handshakeTimeout: 3000 }); sockets.add(ws)
  const frames = [], waits = []; let failure
  ws.on('error', e => { failure = e; for (const wait of waits.splice(0)) wait.reject(e) }); ws.once('close', () => sockets.delete(ws))
  ws.on('message', raw => { const frame = JSON.parse(raw); const index = waits.findIndex(w => w.kind === frame.kind); if (index >= 0) waits.splice(index, 1)[0].resolve(frame); else frames.push(frame) })
  return { ws, next(kind) { if (failure) return Promise.reject(failure); const index = frames.findIndex(f => f.kind === kind); if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`missing ${kind}`)), 4000); waits.push({ kind, resolve: frame => { clearTimeout(timer); resolve(frame) }, reject: e => { clearTimeout(timer); reject(e) } }) }) } }
}
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
test('Node production TLS listener: profile readiness, pairing/auth/commands and rotation closes old sockets', { timeout: 20000 }, async () => {
  try {
    process.env.PROFER_REMOTE_PORT = String(await freePort()); await remote.setRemoteServiceEnabled(true); assert.equal(remote.getRemoteProfile().endpoints.some(e => e.scope === 'public'), false)
    await remote.startRemoteFrp(); target = globalThis.__isolatedTlsPort
    const cert = remote.getRemoteTlsCertificate().cert; const profile = remote.getRemoteProfile(); const endpoint = profile.endpoints.find(e => e.scope === 'public')
    assert.notEqual(target, Number(process.env.PROFER_REMOTE_PORT)); assert.equal(endpoint.trustMode, 'pinned'); assert.equal(endpoint.pin.value, 'sha256/' + createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'))
    // 模拟可信本机 QR 发布；仅持有本次隔离 pairing code。
    await remote.getRemotePairingQr(); const pairingModule = globalThis.__isolatedPairingManager
    const qr = pairingModule
    assert.equal(qr?.v, 2); assert.ok(qr?.c); assert.ok(qr?.h)
    const pairing = connect(cert); await pairing.next('remote_hello'); pairing.ws.send(JSON.stringify({ type: 'pair', deviceId: profile.deviceId, pairingCode: qr.c })); const paired = await pairing.next('paired'); assert.ok(paired.credential)
    const duplicate = connect(cert); await duplicate.next('remote_hello'); const rejected = new Promise(resolve => duplicate.ws.once('close', resolve)); duplicate.ws.send(JSON.stringify({ type: 'pair', deviceId: profile.deviceId, pairingCode: qr.c })); assert.equal(await rejected, 4001)
    const live = connect(cert); await live.next('remote_hello'); live.ws.send(JSON.stringify({ type: 'authenticate', deviceId: profile.deviceId, credential: paired.credential })); assert.equal((await live.next('hello')).profile.deviceId, profile.deviceId)
    live.ws.send('{"type":"ping"}'); assert.equal((await live.next('pong')).kind, 'pong'); live.ws.send('{"type":"list_sessions","_cmdId":"production-test"}'); const result = await live.next('command_result'); assert.equal(result.ok, true); assert.equal(result.requestId, 'production-test')
    const closed = new Promise(resolve => live.ws.once('close', resolve)); await remote.startRemoteFrp(); await closed; assert.equal(remote.getRemoteProfile().endpoints.find(e => e.scope === 'public').pin.value, endpoint.pin.value)
    await remote.rotateRemoteTls(); target = globalThis.__isolatedTlsPort; assert.notEqual(remote.getRemoteProfile().endpoints.find(e => e.scope === 'public').pin.value, endpoint.pin.value)
    await assert.rejects(connect(cert).next('remote_hello'), /certificate|self.signed|verify/i)
    await remote.stopRemoteService(); assert.equal(remote.getRemoteTlsCertificate(), undefined); assert.equal(remote.getRemoteProfile().endpoints.some(e => e.scope === 'public'), false)
  } finally {
    for (const ws of sockets) ws.terminate(); await remote.stopRemoteService(); Module._load = originalLoad
    for (const [key, value] of Object.entries({ PROFER_CONFIG_DIR: before.config, CLAUDE_CONFIG_DIR: before.sdk, PROFER_REMOTE_PORT: before.port })) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  }
})
