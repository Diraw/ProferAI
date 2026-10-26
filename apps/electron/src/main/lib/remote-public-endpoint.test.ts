import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'profer-public-endpoint-')); process.env.PROFER_CONFIG_DIR = dir })
afterEach(() => { delete process.env.PROFER_CONFIG_DIR; rmSync(dir, { recursive: true, force: true }) })

const { normalizePublicEndpoint, savePublicEndpointConfig, loadPublicEndpointConfig, getPublicEndpointInfo, getPublicEndpoint } = await import('./remote-public-endpoint')

describe('public endpoint config', () => {
  test('normalizes IP, domain and IPv6 inputs; rejects bad host or port', () => {
    expect(normalizePublicEndpoint({ host: ' 203.0.113.7 ', port: 17788 })).toEqual({ host: '203.0.113.7', port: 17788 })
    expect(normalizePublicEndpoint({ host: '[2001:db8::1]', port: '17788' })).toEqual({ host: '2001:db8::1', port: 17788 })
    expect(normalizePublicEndpoint({ host: 'remote.example.com', port: 443 })).toEqual({ host: 'remote.example.com', port: 443 })
    for (const input of [{ host: '', port: 17788 }, { host: 'a b', port: 17788 }, { host: 'x', port: 80 }, { host: 'x', port: 70000 }, { host: 'x', port: 17788.5 }, null]) {
      expect(() => normalizePublicEndpoint(input)).toThrow()
    }
  })

  test('save/load roundtrip and clear', () => {
    expect(loadPublicEndpointConfig()).toBeNull()
    savePublicEndpointConfig({ host: '203.0.113.7', port: 17788 })
    expect(loadPublicEndpointConfig()).toEqual({ host: '203.0.113.7', port: 17788 })
    savePublicEndpointConfig(null)
    expect(loadPublicEndpointConfig()).toBeNull()
  })

  test('domain endpoint is system-trusted WSS; IP endpoint fails closed without a certificate', () => {
    savePublicEndpointConfig({ host: 'remote.example.com', port: 443 })
    expect(getPublicEndpointInfo()).toEqual({ host: 'remote.example.com', port: 443, url: 'wss://remote.example.com:443/ws', trustMode: 'system', pin: null })
    expect(getPublicEndpoint()).toEqual({ url: 'wss://remote.example.com/ws', scope: 'public', trustMode: 'system' })

    savePublicEndpointConfig({ host: '203.0.113.7', port: 17788 })
    const info = getPublicEndpointInfo()
    expect(info?.trustMode).toBe('pinned')
    expect(info?.url).toBe('wss://203.0.113.7:17788/ws')
    // 证书还没生成时不能把没有 pin 的公网端点塞进二维码。
    expect(getPublicEndpoint()).toBeUndefined()
  })
})
