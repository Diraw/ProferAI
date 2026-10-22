import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
const root = mkdtempSync(join(tmpdir(), 'remote-restart-test-'))
const previous = { config: process.env.PROFER_CONFIG_DIR, sdk: process.env.CLAUDE_CONFIG_DIR, port: process.env.PROFER_REMOTE_PORT }
process.env.PROFER_CONFIG_DIR = root; process.env.CLAUDE_CONFIG_DIR = join(root, 'sdk')
const electron = await import('electron')
Object.assign(electron.safeStorage, { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() })
const events: string[] = []
mock.module('./remote-frp-service', () => ({ getFrpStatus: () => ({ running: false }), getFrpConfig: () => ({ startOnLaunch: true, publicUrl: 'wss://test.example/ws' }), ensureFrpReady: async () => ({ startOnLaunch: true, publicUrl: 'wss://test.example/ws' }), getFrpPublicEndpoint: () => undefined, startFrp: async () => {}, getFrpPublicUrl: () => undefined, startFrpIfConfigured: async (port: number) => { events.push(`start-${port}`) }, stopFrp: async () => { events.push('stopping'); await Bun.sleep(40); events.push('exited') } }))
const remote = await import('./remote-service')
async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port; await new Promise<void>((r) => server.close(() => r())); return port }
afterAll(async () => { await remote.stopRemoteService(); if (previous.config === undefined) delete process.env.PROFER_CONFIG_DIR; else process.env.PROFER_CONFIG_DIR = previous.config; if (previous.sdk === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.sdk; if (previous.port === undefined) delete process.env.PROFER_REMOTE_PORT; else process.env.PROFER_REMOTE_PORT = previous.port; rmSync(root, { recursive: true, force: true }) })
test('real remote-service fast restart shuts down HTTP without auto-starting FRP', async () => {
  const first = await freePort(); const second = await freePort(); process.env.PROFER_REMOTE_PORT = String(first)
  await remote.setRemoteServiceEnabled(true); expect(remote.getRemoteServiceStatus().running).toBe(true)
  // 当前阶段不启用 FRP：即使草稿里 startOnLaunch=true，也不能自动拉起 frpc。
  expect(events).toEqual([])
  process.env.PROFER_REMOTE_PORT = String(second); const restart = remote.restartRemoteService(); const again = remote.restartRemoteService()
  await Bun.sleep(5); expect(events).toEqual(['stopping'])
  await restart; await again
  expect(events.some((event) => event.startsWith('start-'))).toBe(false)
  expect((await fetch(`http://127.0.0.1:${second}/health`)).status).toBe(200)
  await remote.stopRemoteService(); expect(remote.getRemoteServiceStatus().running).toBe(false)
}, 15000)
