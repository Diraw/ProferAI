import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { safeStorage } from 'electron'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
let origin = 'https://api.example.com'
mock.module('./plugin-manager', () => ({ getInstalledPlugin: () => ({ manifest: { network: { credentials: [{ id: 'api', title: 'API', origin, header: 'Authorization', scheme: 'bearer' }] } } }) }))
const { setPluginCredential, pluginCredentialHeader } = await import('./plugin-credentials')
let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-credential-test-')); process.env.PROFER_CONFIG_DIR = root; origin = 'https://api.example.com'
  spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
  spyOn(safeStorage, 'encryptString').mockImplementation((value) => Buffer.from(value.split('').reverse().join('')))
  spyOn(safeStorage, 'decryptString').mockImplementation((value) => value.toString().split('').reverse().join(''))
})
afterEach(() => { mock.restore(); delete process.env.PROFER_CONFIG_DIR; rmSync(root, { recursive: true, force: true }) })
test('凭据加密落盘，只能发送到声明的 origin；修改声明后需要重新配置', () => {
  setPluginCredential('com.example.test', 'api', 'private-secret')
  expect(readFileSync(join(root, 'plugin-credentials.json'), 'utf8')).not.toContain('private-secret')
  expect(pluginCredentialHeader('com.example.test', 'api', origin)).toEqual({ Authorization: 'Bearer private-secret' })
  expect(() => pluginCredentialHeader('com.example.test', 'api', 'https://other.example')).toThrow('绑定')
  origin = 'https://new.example.com'
  expect(() => pluginCredentialHeader('com.example.test', 'api', origin)).toThrow('配置')
})
test('不同插件凭据隔离，清除后无法调用', () => {
  setPluginCredential('com.example.test', 'api', 'private-secret')
  expect(() => pluginCredentialHeader('com.example.other', 'api', origin)).toThrow()
  setPluginCredential('com.example.test', 'api', null)
  expect(() => pluginCredentialHeader('com.example.test', 'api', origin)).toThrow()
})
test('安全存储不可用时拒绝明文降级，拒绝换行注入', () => {
  spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
  expect(() => setPluginCredential('com.example.test', 'api', 'private-secret')).toThrow('安全存储')
  expect(() => setPluginCredential('com.example.test', 'api', 'secret\r\nHost: other')).toThrow('格式')
})
