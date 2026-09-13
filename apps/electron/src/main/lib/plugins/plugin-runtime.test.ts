import { dialog } from 'electron'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel } from '@profer/shared'

let channels: Channel[] = []
let response = 1
mock.module('electron', () => ({ app: { getVersion: () => '0.15.80' }, BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, dialog: { showMessageBox: async () => ({ response }) }, shell: {} }))
mock.module('../main-window-state', () => ({ getMainWindow: () => ({}) }))
mock.module('../channel-manager', () => ({ listChannels: () => channels, decryptApiKey: () => 'api-key' }))
Object.assign(dialog, { showMessageBox: async () => ({ response }) })
const manager = await import('./plugin-manager')
const permissions = await import('./plugin-permissions')
const routing = await import('./plugin-routing')
const { PluginRequests } = await import('./plugin-requests')
let root = ''
const pluginId = 'com.example.runtime'
const rule = { id: 'peak', title: '峰时', channelId: 'channel', modelId: 'auto', start: '00:00', end: '00:00' }
function source(extra: Record<string, unknown> = {}): string {
  const path = join(root, 'source'); mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'index.html'), '<!doctype html>')
  writeFileSync(join(path, 'profer-plugin.json'), JSON.stringify({
    schemaVersion: 1, id: pluginId, name: 'Runtime', version: '1.0.0',
    permissions: ['models.read', 'modelRouting.rules.write', 'network.fetch', 'agent.tools'],
    network: { origins: ['https://example.com'] },
    contributes: { pages: [{ id: 'main', title: 'Main', entry: 'index.html' }], modelRoutingPolicies: [{ id: 'routing', kind: 'model-routing.rules.v1' }] },
    ...extra,
  }))
  return path
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-plugin-runtime-')); process.env.PROFER_CONFIG_DIR = join(root, 'config'); response = 1
  channels = [{ id: 'channel', name: '渠道', provider: 'anthropic', baseUrl: 'https://api.example.com', apiKey: 'secret', enabled: true, createdAt: 0, updatedAt: 0, models: [{ id: 'auto', name: '自动', enabled: true }] }]
  expect(manager.installPluginPackage(source()).ok).toBe(true)
})
afterEach(() => { delete process.env.PROFER_CONFIG_DIR; rmSync(root, { recursive: true, force: true }) })

test('声明权限不足以调用宿主，取消授权不生效；授权后可用，撤销立即拒绝', async () => {
  expect(() => permissions.assertPluginPermission(pluginId, 'models.read')).toThrow('授权')
  response = 0; expect(await permissions.authorizePlugin(pluginId)).toBe(false)
  expect(() => permissions.assertPluginPermission(pluginId, 'models.read')).toThrow()
  response = 1; await permissions.authorizePlugin(pluginId)
  expect(() => permissions.assertPluginPermission(pluginId, 'models.read')).not.toThrow()
  permissions.revokePluginPermissions(pluginId)
  expect(() => permissions.assertPluginPermission(pluginId, 'models.read')).toThrow()
})
test('更新新增权限和网络域名不会继承旧授权', async () => {
  await permissions.authorizePlugin(pluginId)
  expect(() => permissions.assertPluginOrigin(pluginId, 'https://example.com')).not.toThrow()
  manager.installPluginPackage(source({ permissions: ['models.read', 'models.invoke', 'network.fetch'], network: { origins: ['https://example.com', 'https://new.example.com'] } }), true)
  expect(() => permissions.assertPluginPermission(pluginId, 'models.read')).not.toThrow()
  expect(() => permissions.assertPluginPermission(pluginId, 'models.invoke')).toThrow()
  expect(() => permissions.assertPluginOrigin(pluginId, 'https://new.example.com')).toThrow()
})
test('路由默认不影响手动模型；选定后命中，停用或目标失效后恢复原模型', async () => {
  await permissions.authorizePlugin(pluginId); routing.setPluginRoutingRules(pluginId, [rule])
  const input = { channelId: 'manual', modelId: 'manual-model' }
  expect(routing.routePluginModel('chat:task', input)).toBe(input)
  routing.setTaskRouting('chat:task', pluginId)
  expect(routing.routePluginModel('chat:task', input)).toMatchObject({ channelId: 'channel', modelId: 'auto' })
  expect(routing.getTaskRouting('chat:task').lastDecision?.reason).toContain('峰时')
  channels[0]!.models[0]!.enabled = false
  expect(routing.routePluginModel('chat:task', input)).toBe(input)
  channels[0]!.models[0]!.enabled = true; manager.setPluginEnabled(pluginId, false)
  expect(routing.routePluginModel('chat:task', input)).toBe(input)
})
test('任务路由相互隔离，每个任务同时只选一个提供者', async () => {
  await permissions.authorizePlugin(pluginId); routing.setTaskRouting('agent:a', pluginId)
  expect(routing.getTaskRouting('agent:b').pluginId).toBeNull()
  routing.setTaskRouting('agent:a', null)
  expect(routing.getTaskRouting('agent:a').pluginId).toBeNull()
})
test('跨午夜时段按开始日判定，结束时间不包含在内', () => {
  const overnight = { ...rule, start: '22:00', end: '06:00', days: [1] }
  expect(routing.matchesRoutingTime(overnight, new Date(2026, 8, 14, 23))).toBe(true)
  expect(routing.matchesRoutingTime(overnight, new Date(2026, 8, 15, 5))).toBe(true)
  expect(routing.matchesRoutingTime(overnight, new Date(2026, 8, 15, 6))).toBe(false)
  expect(routing.matchesRoutingTime(overnight, new Date(2026, 8, 15, 23))).toBe(false)
})
test('不接受非法时间、重复规则和失效模型', async () => {
  await permissions.authorizePlugin(pluginId)
  expect(() => routing.setPluginRoutingRules(pluginId, [{ ...rule, start: '25:10' }])).toThrow()
  expect(() => routing.setPluginRoutingRules(pluginId, [rule, rule])).toThrow()
  expect(() => routing.setPluginRoutingRules(pluginId, [{ ...rule, modelId: 'missing' }])).toThrow('不可用')
})
test('工具和消息操作只能引用已声明页面；网络不能声明通配符', () => {
  const raw = { schemaVersion: 1, id: pluginId, name: 'Test', version: '1.0.0', permissions: ['agent.tools'], contributes: { pages: [{ id: 'main', title: 'Main', entry: 'index.html' }], tools: [{ id: 'query', title: 'Query', description: 'Query', pageId: 'missing', parameters: {} }] } }
  expect(() => manager.parsePluginManifest(raw)).toThrow('不存在的页面')
  expect(() => manager.parsePluginManifest({ ...raw, contributes: { pages: raw.contributes.pages }, network: { origins: ['https://*.example.com'] } })).toThrow()
})
test('调用取消按插件隔离，超时会释放并发槽位', async () => {
  const requests = new PluginRequests()
  let signalA: AbortSignal | undefined
  const a = requests.run('a', 'call', async (signal) => { signalA = signal; return new Promise(() => {}) })
  const b = requests.run('b', 'call', async () => 42)
  requests.cancelPlugin('a')
  await expect(a).rejects.toThrow('取消')
  expect(signalA?.aborted).toBe(true); expect(await b).toBe(42)
  await expect(requests.run('a', 'timeout', async () => new Promise(() => {}), 5)).rejects.toThrow('超时')
  expect(await requests.run('a', 'timeout', async () => 'again')).toBe('again')
})
test('同一插件不能复用未完成的请求 ID', async () => {
  const requests = new PluginRequests()
  const first = requests.run('a', 'same', async () => new Promise(() => {}))
  await expect(requests.run('a', 'same', async () => null)).rejects.toThrow('已在使用')
  requests.cancelPlugin('a'); await expect(first).rejects.toThrow()
})
test('Chat 不路由到订阅渠道，Claude 不路由到 Pi 专用渠道', async () => {
  await permissions.authorizePlugin(pluginId); routing.setPluginRoutingRules(pluginId, [rule])
  routing.setTaskRouting('chat:runtime', pluginId); routing.setTaskRouting('agent:runtime', pluginId)
  const input = { channelId: 'manual', modelId: 'manual' }
  channels[0]!.provider = 'xai'; channels[0]!.credentialMode = 'oauth'; channels[0]!.agentExperimentalEnabled = true
  expect(routing.routePluginModel('chat:runtime', input)).toBe(input)
  expect(routing.routePluginModel('agent:runtime', input, 'claude')).toBe(input)
  expect(routing.routePluginModel('agent:runtime', input, 'pi').modelId).toBe('auto')
})
test('关闭单个页面只取消该页面调用', async () => {
  const requests = new PluginRequests()
  const first = requests.run('plugin', 'first', async () => new Promise(() => {}), 5000, 1)
  const second = requests.run('plugin', 'second', async () => new Promise(() => {}), 5000, 2)
  requests.cancelOwner(1)
  await expect(first).rejects.toThrow('取消')
  await expect(requests.run('plugin', 'second', async () => null)).rejects.toThrow('已在使用')
  requests.cancelOwner(2); await expect(second).rejects.toThrow('取消')
})
test('替换在发布目录前失败时保留旧插件', () => {
  manager.setPluginMutationListener(() => { throw new Error('模拟发布前异常') })
  try {
    expect(manager.installPluginPackage(source({ version: '1.0.1' }), true).ok).toBe(false)
    expect(manager.getInstalledPlugin(pluginId)?.manifest.version).toBe('1.0.0')
  } finally { manager.setPluginMutationListener(null) }
})

test('刷新时识别直接拖入插件目录的开发文件夹', () => {
  const pluginsDir = join(process.env.PROFER_CONFIG_DIR!, 'plugins')
  rmSync(join(pluginsDir, pluginId), { recursive: true, force: true })
  cpSync(source(), join(pluginsDir, 'capability-demo'), { recursive: true })
  const discovered = manager.listInstalledPlugins()
  expect(discovered.map((plugin) => plugin.manifest.id)).toEqual([pluginId])
  expect(manager.listInstalledPlugins()[0]?.enabled).toBe(true)
})
