import { buildPluginAgentTools } from '../src/main/lib/plugins/plugin-agent-tools'
import { updateSettings } from '../src/main/lib/settings-service'
/** 真实 Electron 沙箱冒烟测试；所有配置和模型请求均使用临时数据。 */
import { app, BrowserWindow, protocol, WebContentsView } from 'electron'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pluginViewManager, registerPluginHostIpc } from '../src/main/lib/plugins/plugin-view-manager'
import { installPluginPackage, getInstalledPlugin } from '../src/main/lib/plugins/plugin-manager'
import { revokePluginPermissions } from '../src/main/lib/plugins/plugin-permissions'
import { createChannel } from '../src/main/lib/channel-manager'
import { setMainWindow } from '../src/main/lib/main-window-state'

process.on('uncaughtException', (error) => { console.error('PLUGIN_SMOKE_UNCAUGHT', error); app.exit(1) })
const root = mkdtempSync(join(tmpdir(), 'profer-plugin-electron-'))
process.env.PROFER_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.PROFER_CONFIG_DIR, { recursive: true })
app.setPath('userData', join(root, 'electron'))
protocol.registerSchemesAsPrivileged([{ scheme: 'profer-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const deadline = setTimeout(() => { console.error('PLUGIN_SMOKE_TIMEOUT'); app.exit(1) }, 45_000)
const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer smoke-secret')
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    assert.equal(JSON.parse(body).max_tokens, 1024)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"宿主模型调用成功"}}]}\n\ndata: [DONE]\n\n')
  })
})
async function main(): Promise<void> {
  await app.whenReady()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string')
  const channel = createChannel({ name: '冒烟模型', provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'smoke-secret', models: [{ id: 'smoke-model', name: 'Smoke', enabled: true }], enabled: true })
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  setMainWindow(window); pluginViewManager.setOwnerWindow(window); registerPluginHostIpc()
  const pluginId = 'com.profer.capability-demo'
  assert.equal(installPluginPackage(resolve(process.cwd(), '../../examples/plugins/capability-demo')).ok, true)
  async function openPage() {
    pluginViewManager.activate(pluginId, 'main', null)
    const view = window.contentView.children.flatMap((host) => host.children).find((child) => child instanceof WebContentsView) as WebContentsView
    assert(view)
    await new Promise<void>((done, reject) => {
      view.webContents.once('did-finish-load', () => done())
      view.webContents.once('did-fail-load', (_event, code, message) => reject(new Error(`${code}: ${message}`)))
    })
    return view.webContents
  }
  let contents = await openPage()
  assert.equal(await contents.executeJavaScript('window.profer.models.list().then(() => false, () => true)'), true)
  const manifest = getInstalledPlugin(pluginId)!.manifest
  writeFileSync(join(root, 'config', 'plugin-permissions.json'), JSON.stringify({ [pluginId]: { permissions: manifest.permissions, origins: manifest.network?.origins } }))
  pluginViewManager.closePlugin(pluginId); contents = await openPage()
  assert.deepEqual(await contents.executeJavaScript('({node:typeof require,host:typeof window.electronAPI})'), { node: 'undefined', host: 'undefined' })
  const models = await contents.executeJavaScript('window.profer.models.list()')
  assert.equal(models[0].modelId, 'smoke-model'); assert.equal(JSON.stringify(models).includes('smoke-secret'), false)
  await contents.executeJavaScript(`window.profer.storage.set('model',${JSON.stringify({ channelId: channel.id, modelId: 'smoke-model' })})`)
  const servers: Record<string, Record<string, unknown>> = {}
  const piTools = await buildPluginAgentTools(await import('@anthropic-ai/claude-agent-sdk'), servers, () => true)
  assert.equal(Object.keys(servers).length, 1)
  const uppercase = piTools.find((tool) => tool.name.endsWith('__uppercase'))!
  assert(uppercase && uppercase.name.length <= 64)
  const piResult = await uppercase.execute('pi-call', { text: 'hello' }, undefined, undefined, {} as never)
  assert.equal(JSON.parse((piResult.content[0] as { text: string }).text).text, 'HELLO')
  const result = await pluginViewManager.runTool(pluginId, 'summarize', { text: '需要总结的测试文本' })
  assert.equal((result as { text: string }).text, '宿主模型调用成功')
  assert.equal(await contents.executeJavaScript("window.profer.network.fetch({requestId:'denied',url:'https://unauthorized.example/'}).then(()=>false,()=>true)"), true)
  await contents.executeJavaScript("window.__themePromise = new Promise(resolve => window.profer.onContextChanged(context => resolve(context.theme))); true")
  updateSettings({ themeMode: 'light' })
  assert.equal(await contents.executeJavaScript('window.__themePromise'), 'light')
  pluginViewManager.activate(pluginId, 'main', { kind: 'chat', sessionId: 'smoke', selection: '仅交给可见页面' })
  const runtimeView = window.contentView.children.flatMap((host) => host.children).find((child) => child instanceof WebContentsView && child.webContents.id !== contents.id) as WebContentsView
  assert.equal(await runtimeView.webContents.executeJavaScript('window.profer.context.read()'), null)
  await runtimeView.webContents.executeJavaScript("window.profer.tools.register('uppercase', async () => new Promise(resolve => setTimeout(() => resolve({text:'still running'}), 50)))")
  const pending = pluginViewManager.runTool(pluginId, 'uppercase', { text: 'hello' })
  pluginViewManager.close(pluginId, 'main')
  assert.deepEqual(await pending, { text: 'still running' })
  revokePluginPermissions(pluginId)
  await assert.rejects(uppercase.execute('revoked', { text: 'hello' }, undefined, undefined, {} as never))
  assert.equal(await runtimeView.webContents.executeJavaScript('window.profer.models.list().then(() => false, () => true)'), true)
  pluginViewManager.dispose(); window.destroy()
  console.log('PLUGIN_SMOKE_OK: 沙箱、权限、模型目录、私有存储、Agent 工具、宿主模型调用、域名拒绝、撤权')
}
main().then(() => finish(0), (error) => { console.error('PLUGIN_SMOKE_FAILED', error); finish(1) })
function finish(code: number): void {
  clearTimeout(deadline); server.close(); pluginViewManager.dispose()
  try { rmSync(root, { recursive: true, force: true }) } catch { /* Electron 文件句柄退出时释放 */ }
  app.exit(code)
}
