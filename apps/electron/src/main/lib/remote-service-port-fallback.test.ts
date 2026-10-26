import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'

const root = mkdtempSync(join(tmpdir(), 'remote-port-fallback-test-'))
const previous = { config: process.env.PROFER_CONFIG_DIR, sdk: process.env.CLAUDE_CONFIG_DIR, port: process.env.PROFER_REMOTE_PORT }
process.env.PROFER_CONFIG_DIR = root
process.env.CLAUDE_CONFIG_DIR = join(root, 'sdk')

const electron = await import('electron')
Object.assign(electron.safeStorage, { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() })
mock.module('./remote-frp-service', () => ({
  getFrpStatus: () => ({ running: false }),
  getFrpConfig: () => ({ startOnLaunch: false, publicUrl: '' }),
  ensureFrpReady: async () => ({ startOnLaunch: false, publicUrl: '' }),
  getFrpPublicEndpoint: () => undefined,
  startFrp: async () => {},
  getFrpPublicUrl: () => undefined,
  startFrpIfConfigured: async () => {},
  stopFrp: async () => {},
}))

const remote = await import('./remote-service')
const { updateSettings, getSettings } = await import('./settings-service')

function bind(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', () => resolve()) })
}
function unbind(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
async function freePort(): Promise<number> {
  const server = createServer()
  await bind(server, 0)
  const port = (server.address() as { port: number }).port
  await unbind(server)
  return port
}
/** 占用一段连续端口（供「候选全被占」用例使用）；端口段不可用就换一段重试。 */
async function occupyRange(count: number): Promise<{ base: number; servers: Server[] }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const base = await freePort()
    const servers: Server[] = []
    let complete = true
    for (let i = 0; i < count; i += 1) {
      const server = createServer()
      try {
        await bind(server, base + i)
        servers.push(server)
      } catch {
        complete = false
        try { server.close() } catch { /* ignore */ }
        break
      }
    }
    if (complete) return { base, servers }
    for (const server of servers) await unbind(server)
  }
  throw new Error('无法占用连续端口段')
}

afterAll(async () => {
  await remote.setRemoteServiceEnabled(false)
  if (previous.config === undefined) delete process.env.PROFER_CONFIG_DIR; else process.env.PROFER_CONFIG_DIR = previous.config
  if (previous.sdk === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.sdk
  if (previous.port === undefined) delete process.env.PROFER_REMOTE_PORT; else process.env.PROFER_REMOTE_PORT = previous.port
  rmSync(root, { recursive: true, force: true })
})

test('首选端口被占时顺延到下一个可用端口，并提示重新扫码', async () => {
  updateSettings({ pocketModePort: 0 })
  const base = await freePort()
  const blocker = createServer()
  await bind(blocker, base)
  process.env.PROFER_REMOTE_PORT = String(base)
  try {
    const status = await remote.setRemoteServiceEnabled(true)
    expect(status.running).toBe(true)
    expect(status.error).toBeNull()
    expect(status.port).toBeGreaterThan(base)
    expect(status.notice).toContain(String(status.port))
    expect(status.localUrl).toBe(`http://127.0.0.1:${status.port}`)
  } finally {
    await remote.setRemoteServiceEnabled(false)
    await unbind(blocker)
  }
}, 20000)

test('端口只是短暂被占时，重试后仍在原端口启动（不换端口）', async () => {
  updateSettings({ pocketModePort: 0 })
  const base = await freePort()
  const blocker = createServer()
  await bind(blocker, base)
  process.env.PROFER_REMOTE_PORT = String(base)
  try {
    const starting = remote.setRemoteServiceEnabled(true)
    await Bun.sleep(250)
    await unbind(blocker)
    const status = await starting
    expect(status.running).toBe(true)
    expect(status.port).toBe(base)
    expect(status.notice).toBeNull()
  } finally {
    await remote.setRemoteServiceEnabled(false)
  }
}, 20000)

test('顺延后的端口会写入设置，下次启动直接复用（不会来回跳）', async () => {
  delete process.env.PROFER_REMOTE_PORT
  const base = await freePort()
  const blocker = createServer()
  await bind(blocker, base)
  try {
    updateSettings({ pocketModePort: base })
    const first = await remote.setRemoteServiceEnabled(true)
    expect(first.running).toBe(true)
    expect(first.port).toBeGreaterThan(base)
    // 顺延得到的端口要写回设置，下次启动才能直接复用。
    expect(getSettings().pocketModePort).toBe(first.port)
    const chosen = first.port
    await remote.setRemoteServiceEnabled(false)

    // 原端口已经空出来，但设置里记住的是顺延后的端口，重启必须沿用它。
    await unbind(blocker)
    const second = await remote.setRemoteServiceEnabled(true)
    expect(second.running).toBe(true)
    expect(second.port).toBe(chosen)
  } finally {
    await remote.setRemoteServiceEnabled(false)
    try { await unbind(blocker) } catch { /* ignore */ }
  }
}, 20000)

test('候选端口全部被占时只报状态，不抛异常', async () => {
  const { base, servers } = await occupyRange(remote.REMOTE_PORT_FALLBACK_COUNT)
  delete process.env.PROFER_REMOTE_PORT
  updateSettings({ pocketModePort: base })
  try {
    const status = await remote.setRemoteServiceEnabled(true)
    expect(status.running).toBe(false)
    expect(status.error).toContain('均已被占用')
    expect(status.notice).toBeNull()
  } finally {
    await remote.setRemoteServiceEnabled(false)
    for (const server of servers) await unbind(server)
  }
}, 30000)

test('停止后立刻可以重新绑定同一端口（退出时不占着端口）', async () => {
  updateSettings({ pocketModePort: 0 })
  const base = await freePort()
  process.env.PROFER_REMOTE_PORT = String(base)
  await remote.setRemoteServiceEnabled(true)
  await remote.setRemoteServiceEnabled(false)
  const probe = createServer()
  try {
    await bind(probe, base)
  } finally {
    await unbind(probe)
  }
}, 20000)
