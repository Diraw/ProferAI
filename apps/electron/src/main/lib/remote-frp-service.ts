import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, accessSync } from 'node:fs'
import { join } from 'node:path'
import { list } from 'tar'
import AdmZip from 'adm-zip'
import { app, clipboard, dialog } from 'electron'
import WebSocket from 'ws'
import { RemoteLifecycleQueue, waitForOwnedExit } from './remote-lifecycle'
import { REMOTE_PROTOCOL, validateEndpoint, type RemotePin, type RemoteEndpoint } from '@profer/shared'
import { protectSecret, revealSecret } from './remote-identity'
import { FrpControlStore, type FrpControlMaterial } from './remote-frp-control-identity'
import { publicMode, validateFrpDraft, frpMissing, pinnedPublicUrl, deploymentFiles, renderDeploymentInstructions, selectFrpAsset, selectFrpServerAssets, validateArchiveEntry, validateFrpConfig, verifySha256, renderFrpcToml, type FrpConfig, type FrpDeploymentMaterial, type FrpRelease, type FrpServerAsset } from './remote-frp-core'
export type { FrpConfig } from './remote-frp-core'
export interface FrpStatus { installedVersion: string | null; recommendedVersion: string | null; availableVersions: string[]; running: boolean; pid: number | null; log: string[]; error: string | null; config: Omit<FrpConfig, 'authToken'> | null; tokenConfigured?: boolean; readiness?: 'draft' | 'tunnel_ready'; missing?: string[]; generated?: { token: boolean; controlCa: boolean } }
interface Installation { version: string; binary: string; previous?: { version: string; binary: string } }
interface StoredConfig extends Omit<FrpConfig, 'authToken'> { encryptedToken: string | null }
let child: ChildProcess | null = null
const lifecycle = new RemoteLifecycleQueue()
let stopping: Promise<void> | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let desired = false
let generation = 0
let retries = 0
let busy = false
let quitHook = false
const status: FrpStatus = { installedVersion: null, recommendedVersion: null, availableVersions: [], running: false, pid: null, log: [], error: null, config: null }
function dir(): string { const p = join(app.getPath('userData'), 'remote-frp'); mkdirSync(p, { recursive: true }); return p }
function atomic(name: string, value: unknown): void { const p = join(dir(), name); writeFileSync(`${p}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${p}.tmp`, p) }
function controlStore(): FrpControlStore { return new FrpControlStore(join(dir(), 'control'), protectSecret, revealSecret) }
function writeConfig(c: FrpConfig): void { const { authToken, ...fields } = c; atomic('config.json', { ...fields, encryptedToken: authToken ? protectSecret(authToken) : null }) }
function loadControlMaterial(): FrpControlMaterial | null { try { return controlStore().load() } catch { return null } }
function loadInstall(): Installation | null { const p = join(dir(), 'current.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Installation : null }
function loadConfig(): FrpConfig | null {
  const p = join(dir(), 'config.json'); if (!existsSync(p)) return null
  const c = JSON.parse(readFileSync(p, 'utf8')) as StoredConfig
  const { encryptedToken, ...fields } = c
  return validateFrpDraft({ ...fields, authToken: encryptedToken ? revealSecret(encryptedToken) : '' })
}
export function getFrpConfig(): FrpConfig | null { return loadConfig() }
export function getFrpPublicUrl(): string | undefined { try { const c = loadConfig(); if (!c || publicMode(c) !== 'system') return undefined; validateFrpConfig(c); return c.publicUrl } catch { return undefined } }
export function getFrpPublicEndpoint(pin?: RemotePin, ip?: string): RemoteEndpoint | undefined {
  try {
    const c = loadConfig(); if (!c) return undefined
    validateFrpConfig(c)
    if (publicMode(c) === 'system') return validateEndpoint({ url: c.publicUrl, scope: 'public', trustMode: 'system' })
    if (!pin || ip !== c.serverAddr) return undefined
    return validateEndpoint({ url: pinnedPublicUrl(c), scope: 'public', trustMode: 'pinned', pin })
  } catch { return undefined }
}
export function getFrpStatus(): FrpStatus {
  status.installedVersion = loadInstall()?.version ?? null
  const p = join(dir(), 'config.json'); if (existsSync(p)) { const { encryptedToken: _, ...fields } = JSON.parse(readFileSync(p, 'utf8')) as StoredConfig; status.config = fields; status.tokenConfigured = !!_; const c = { ...fields, authToken: _ ? 'configured' : '' }; status.missing = frpMissing(c); status.readiness = status.missing.length ? 'draft' : 'tunnel_ready'; status.generated = { token: !!_, controlCa: !!loadControlMaterial() } }
  return { ...status, log: status.log.slice(-100), availableVersions: [...status.availableVersions] }
}
/**
 * 幂等生成/加载 Profer 托管的 FRP 控制材料（独立 Token + 本地 CA + frps server 证书）。
 * 重复调用复用既有材料；仅当服务器地址变化时用同一 server 私钥重签证书并更新 SAN；
 * rotate=true 才显式更换 CA 与私钥。该路径不触碰桌面 TLS 应用身份 pin。
 */
async function ensureFrpMaterial(rotate = false): Promise<{ config: FrpConfig; material: FrpDeploymentMaterial }> {
  const existing = loadConfig(); if (!existing) throw new Error('请先保存 FRP 配置')
  const draft = validateFrpDraft(existing)
  if (!draft.serverAddr) throw new Error('请先填写 FRP 服务器公网 IP/域名')
  const identity = await controlStore().ensure(draft.serverAddr, rotate)
  const authToken = rotate || !draft.authToken ? randomBytes(32).toString('hex') : draft.authToken
  const config = validateFrpDraft({ ...draft, authToken, trustedCaFile: identity.caCertPath })
  writeConfig(config)
  return { config, material: { caCert: identity.caCert, caKey: identity.caKey, serverCert: identity.serverCert, serverKey: identity.serverKey } }
}
/** 启动/测试/导出前的统一入口：确保托管材料就绪并返回可用的已校验配置。 */
export async function ensureFrpReady(): Promise<FrpConfig> { return (await ensureFrpMaterial()).config }
/** 幂等“生成配置”：缺则生成，地址变化只更新 SAN；已存在且匹配时不做任何改变。 */
export function generateFrpMaterial(): Promise<FrpStatus> { return lifecycle.run(async () => { if (busy) throw new Error('安装操作进行中'); await stopFrpNow(); await ensureFrpMaterial(false); status.error = null; return getFrpStatus() }) }
/** 显式“重新生成”：更换控制 CA、server 私钥与 FRP Token，服务器必须重新部署。 */
export function regenerateFrpMaterial(): Promise<FrpStatus> { return lifecycle.run(async () => { if (busy) throw new Error('安装操作进行中'); await stopFrpNow(); await ensureFrpMaterial(true); status.error = null; return getFrpStatus() }) }
function assertControlCaReadable(c: FrpConfig): void {
  const file = c.trustedCaFile.trim()
  if (!file) throw new Error('FRP 控制链路 CA 未配置；它不是 Pocket WSS CA')
  try {
    if (!statSync(file).isFile()) throw new Error()
    accessSync(file, constants.R_OK)
  } catch {
    throw new Error(`FRP 控制链路 CA 文件不存在或不可读：${file}`)
  }
}
export function saveFrpConfig(input: FrpConfig, remoteToken: string | null): Promise<FrpStatus> { return lifecycle.run(async () => {
  if (busy) throw new Error('安装操作进行中')
  const old = loadConfig(); const c = validateFrpDraft({ ...input, authToken: input.authToken || old?.authToken || '' })
  if (remoteToken && c.authToken === remoteToken) throw new Error('FRP Token 不能复用远控 Token')
  // 控制 CA 由 Profer 托管：已生成材料时恒定指向本地 CA，不接受用户或 renderer 覆盖。
  const managedCa = controlStore().hasMaterial() ? controlStore().caCertPath : c.trustedCaFile
  await stopFrpNow(); writeConfig({ ...c, trustedCaFile: managedCa }); return getFrpStatus()
}) }
async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Profer-frp' } })
  if (!r.ok) throw new Error(`GitHub 元数据请求失败 ${r.status}`)
  return r.json()
}
export async function checkFrpReleases(): Promise<FrpStatus> {
  const releases = await getJson('https://api.github.com/repos/fatedier/frp/releases?per_page=30') as FrpRelease[]
  if (!Array.isArray(releases)) throw new Error('官方 release 元数据无效')
  status.availableVersions = releases.filter((r) => !r.draft && !r.prerelease && /^v0\.\d+\.\d+$/.test(r.tag_name)).map((r) => r.tag_name.slice(1))
  status.recommendedVersion = status.availableVersions[0] ?? null
  return getFrpStatus()
}
/**
 * 部署指令需要官方 sha256 摘要才能自举（下载即校验）。取不到官方 Release 元数据时不退化为无校验安装，
 * 而是直接拒绝生成材料并给出可执行提示。
 */
async function fetchFrpServerAssets(version: string): Promise<FrpServerAsset[]> {
  if (!/^0\.\d+\.\d+$/.test(version)) throw new Error('frps 固定版本格式无效，例如 0.71.0')
  let release: FrpRelease
  try {
    release = await getJson(`https://api.github.com/repos/fatedier/frp/releases/tags/v${version}`) as FrpRelease
  } catch {
    throw new Error(`无法获取官方 frp ${version} 的归档 SHA256 摘要；部署指令必须自带官方校验，请联网后重试`)
  }
  if (!release || release.tag_name !== `v${version}`) throw new Error('官方 release 版本不匹配')
  return selectFrpServerAssets(release)
}
async function download(asset: ReturnType<typeof selectFrpAsset>): Promise<Buffer> {
  const r = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) })
  if (!r.ok || !r.body) throw new Error(`下载失败 ${r.status}`)
  const chunks: Uint8Array[] = []; let length = 0
  const reader = r.body.getReader()
  try { while (true) { const next = await reader.read(); if (next.done) break; const chunk = next.value; length += chunk.length; if (length > 64 * 1024 * 1024) { await reader.cancel(); throw new Error('下载过大') }; chunks.push(chunk) } } finally { reader.releaseLock() }
  if (length !== asset.size) throw new Error('下载不完整')
  const data = Buffer.concat(chunks); verifySha256(data, asset.sha256); return data
}
export async function extractFrpc(data: Buffer, asset: ReturnType<typeof selectFrpAsset>, archivePath: string): Promise<Buffer> {
  let binary: Buffer | null = null; let total = 0; let failure: Error | null = null; let found = false
  const expected = `${asset.root}/${asset.binary}`
  if (asset.name.endsWith('.zip')) {
    const archive = new AdmZip(data)
    for (const entry of archive.getEntries()) {
      const mode = (entry.header.attr >>> 16) & 0xf000
      validateArchiveEntry(entry.entryName, mode === 0xa000 ? 'SymbolicLink' : entry.isDirectory ? 'Directory' : 'File', entry.header.size)
      total += entry.header.size; if (total > 128 * 1024 * 1024) throw new Error('归档解压过大')
      if (entry.entryName === expected) { if (binary) throw new Error('重复二进制'); binary = entry.getData() }
    }
  } else {
    writeFileSync(archivePath, data, { mode: 0o600 })
    await list({ file: archivePath, strict: true, onReadEntry: (entry) => {
      try {
        validateArchiveEntry(entry.path, entry.type, entry.size)
        total += entry.size; if (total > 128 * 1024 * 1024) throw new Error('归档解压过大')
        if (entry.path === expected) {
          if (found || entry.type !== 'File') throw new Error('重复或非文件二进制')
          found = true
          const chunks: Buffer[] = []; entry.on('data', (c: Buffer) => chunks.push(c)); entry.on('end', () => { binary = Buffer.concat(chunks) })
        }
      } catch { failure = new Error('归档包含不安全路径、链接或超大文件') }
    } })
  }
  if (failure) throw failure
  if (!binary || !(binary as Buffer).length) throw new Error('官方归档缺少预期二进制')
  return binary
}
function executableVersion(binary: string): Promise<string> { return new Promise((resolve, reject) => execFile(binary, ['--version'], { shell: false, timeout: 10_000, maxBuffer: 1024 }, (error, stdout) => error ? reject(new Error('FRP 二进制版本/架构验证失败')) : resolve(stdout.trim()))) }
export async function installFrp(version: string): Promise<FrpStatus> {
  if (busy || desired || stopping) throw new Error('请先停止 FRP，再安装版本')
  if (!/^0\.\d+\.\d+$/.test(version)) throw new Error('版本无效')
  busy = true
  const temp = join(dir(), `download-${randomUUID()}`)
  try {
    mkdirSync(temp)
    const c = loadConfig(); if (c && c.serverVersion !== version) throw new Error('客户端版本必须与所填写服务端版本一致')
    const release = await getJson(`https://api.github.com/repos/fatedier/frp/releases/tags/v${version}`) as FrpRelease
    if (release.tag_name !== `v${version}`) throw new Error('官方 release 版本不匹配')
    const asset = selectFrpAsset(release)
    const data = await download(asset); const binary = await extractFrpc(data, asset, join(temp, asset.name))
    const executable = join(temp, asset.binary); writeFileSync(executable, binary, { mode: 0o700 }); if (process.platform !== 'win32') chmodSync(executable, 0o700)
    if (await executableVersion(executable) !== version) throw new Error('FRP 二进制版本不匹配')
    const destination = join(dir(), `frp-${version}-${randomUUID()}`); renameSync(temp, destination)
    const old = loadInstall()
    try { atomic('current.json', { version, binary: join(destination, asset.binary), ...(old ? { previous: { version: old.version, binary: old.binary } } : {}) }) } catch (e) { rmSync(destination, { recursive: true, force: true }); throw e }
    status.error = null; return getFrpStatus()
  } finally { try { rmSync(temp, { recursive: true, force: true }) } finally { busy = false } }
}
export function rollbackFrp(): Promise<FrpStatus> { return lifecycle.run(async () => {
  if (busy) throw new Error('安装操作进行中')
  await stopFrpNow(); const install = loadInstall()
  if (!install?.previous || !existsSync(install.previous.binary)) throw new Error('没有可回滚版本')
  atomic('current.json', { ...install.previous, previous: { version: install.version, binary: install.binary } }); return getFrpStatus()
}) }
function launch(c: FrpConfig, localPort: number, seq: number): void {
  if (!desired || seq !== generation) return
  validateFrpConfig(c)
  const installed = loadInstall(); if (!installed || installed.version !== c.serverVersion) throw new Error('请安装与 frps 相同的客户端版本')
  const path = join(dir(), 'frpc.toml'); writeFileSync(path, renderFrpcToml(c, localPort), { mode: 0o600 })
  const proc = spawn(installed.binary, ['-c', path], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child = proc
  status.pid = proc.pid ?? null; status.running = false
  proc.once('spawn', () => { if (seq === generation) { status.running = true; status.error = null } })
  // 不把 frpc 原始输出暴露到普通日志，保留事件级脱敏状态。
  proc.stdout?.on('data', () => { if (status.log.at(-1) !== 'frpc 输出已脱敏') status.log.push('frpc 输出已脱敏'); status.log = status.log.slice(-100) })
  proc.stderr?.on('data', () => { status.log.push('frpc 诊断输出已脱敏'); status.log = status.log.slice(-100) })
  const finish = (): void => {
    if (seq !== generation || child !== proc) return
    child = null; status.running = false; status.pid = null
    if (desired && retries < 3) { const delay = Math.min(1000 * 2 ** retries++, 8000); status.log.push(`frpc 意外退出，重试 ${retries}/3`); restartTimer = setTimeout(() => { restartTimer = null; try { launch(c, localPort, seq) } catch { status.error = 'FRP 重启失败'; desired = false } }, delay) }
    else if (desired) { desired = false; status.error = 'FRP 重试已用尽，请检查配置后重新启动' }
  }
  proc.once('error', finish); proc.once('exit', finish)
}
export function startFrp(localPort: number): Promise<FrpStatus> { return lifecycle.run(async () => {
  if (busy) throw new Error('安装操作进行中')
  await stopFrpNow()
  if (!loadConfig()) throw new Error('请先保存 FRP 配置')
  const { config: c } = await ensureFrpMaterial()
  validateFrpConfig(c)
  assertControlCaReadable(c)
  if (!quitHook) { quitHook = true; app.once('before-quit', () => { void stopFrp().catch(() => { status.error = 'FRP 退出清理失败' }) }) }
  desired = true; retries = 0; try { launch(c, localPort, generation) } catch (e) { desired = false; throw e }; return getFrpStatus()
}) }
export function stopFrp(): Promise<void> { return lifecycle.run(stopFrpNow) }
function stopFrpNow(): Promise<void> {
  desired = false; generation++; if (restartTimer) clearTimeout(restartTimer); restartTimer = null
  if (stopping) return stopping
  const proc = child; child = null
  status.running = false; status.pid = null
  if (!proc) return Promise.resolve()
  proc.once('exit', () => { if (stopping) stopping = null })
  stopping = waitForOwnedExit(proc).then(() => { stopping = null }, () => { status.error = 'FRP 停止超时，拒绝启动新实例'; throw new Error(status.error) })
  return stopping
}
export async function startFrpIfConfigured(port: number): Promise<void> { try { if (loadConfig()?.startOnLaunch) await startFrp(port) } catch { status.error = 'FRP 自动启动失败，请检查安装和安全存储' } }
export async function exportFrpDeployment(): Promise<string | null> {
  const { config, material } = await ensureFrpMaterial()
  const assets = await fetchFrpServerAssets(config.serverVersion)
  const result = await dialog.showSaveDialog({ defaultPath: 'profer-frps-deployment.zip', filters: [{ name: 'ZIP', extensions: ['zip'] }] })
  if (result.canceled || !result.filePath) return null
  const zip = new AdmZip(); for (const [name, value] of Object.entries(deploymentFiles(config, material, assets))) zip.addFile(name, Buffer.from(value, 'utf8'))
  zip.writeZip(result.filePath); return result.filePath
}
/** 把与 zip 等价的部署指令直接写入系统剪贴板；秘密不经 renderer，也不落盘。 */
export async function copyFrpDeploymentInstructions(): Promise<string> {
  const { config, material } = await ensureFrpMaterial()
  const script = renderDeploymentInstructions(config, material, await fetchFrpServerAssets(config.serverVersion))
  clipboard.writeText(script)
  return `部署指令（含真实 FRP Token、CA 私钥与 server 私钥）已复制到剪贴板：${script.split('\n').length} 行。只粘贴到你自己的 frps 服务器，不要贴进对话或公开渠道。`
}
/** 返回与 zip 等价的部署指令文本，供用户自行查看复制；不写剪贴板、不落盘。 */
export async function getFrpDeploymentInstructions(): Promise<string> {
  const { config, material } = await ensureFrpMaterial()
  return renderDeploymentInstructions(config, material, await fetchFrpServerAssets(config.serverVersion))
}
export async function testFrpEndpoint(profile: { deviceId: string }, token: string, tls?: { cert: string }): Promise<string> {
  if (!loadConfig()) throw new Error('未配置 FRP')
  const ready = await ensureFrpReady(); validateFrpConfig(ready); assertControlCaReadable(ready)
  if (publicMode(ready) === 'pinned' && !tls) throw new Error('桌面 TLS 尚未就绪，请先开始隧道')
  const url = publicMode(ready) === 'pinned' ? pinnedPublicUrl(ready) : ready.publicUrl
  return new Promise((resolve, reject) => {
    // 本机探测使用本机持有的证书作唯一 CA，并保留标准 IP SAN 验证，不绕过 TLS。
    const ws = new WebSocket(url, REMOTE_PROTOCOL, { handshakeTimeout: 8000, rejectUnauthorized: true, ...(tls ? { ca: tls.cert } : {}) })
    let settled = false
    let stage: 'hello' | 'auth' | 'pong' = 'hello'
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); ws.close(); error ? reject(error) : resolve('应用 hello、设备身份、鉴权与 ping/pong 均通过；完整业务消息待实测') }
    const timer = setTimeout(() => finish(new Error('公网应用协议探测超时')), 10_000)
    ws.on('error', () => finish(new Error('公网 TLS/连接验证失败')))
    ws.on('close', () => finish(new Error('公网应用鉴权失败')))
    ws.on('message', (data: import('ws').RawData) => { try {
      const msg = JSON.parse(data.toString()) as { kind: string; protocolVersion?: number; deviceId?: string }
      if (msg.kind === 'remote_hello' && stage === 'hello') { if (msg.deviceId !== profile.deviceId || msg.protocolVersion !== 1) { finish(new Error('公网端点设备身份不匹配')); return }; stage = 'auth'; ws.send(JSON.stringify({ type: 'authenticate', deviceId: profile.deviceId, credential: token })) }
      else if (msg.kind === 'hello' && stage === 'auth') { if (msg.deviceId !== profile.deviceId) { finish(new Error('鉴权设备身份不匹配')); return }; stage = 'pong'; ws.send(JSON.stringify({ type: 'ping' })) }
      else if (msg.kind === 'pong' && stage === 'pong') finish()
    } catch { finish(new Error('公网协议无效')) } })
  })
}
