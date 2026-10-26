import { describe, expect, test } from 'bun:test'
import { isTrustedLegacyTransport } from './remote-legacy-trust'

describe('legacy token transport trust', () => {
  test('accepts end-to-end TLS from any peer', () => {
    expect(isTrustedLegacyTransport({ peer: '203.0.113.7', encrypted: true, hasProxyHeaders: false })).toBe(true)
    expect(isTrustedLegacyTransport({ peer: '203.0.113.7', encrypted: true, hasProxyHeaders: true })).toBe(true)
  })

  test('accepts plaintext only from private peers, with loopback reverse proxies', () => {
    expect(isTrustedLegacyTransport({ peer: '192.168.1.5', encrypted: false, hasProxyHeaders: false })).toBe(true)
    expect(isTrustedLegacyTransport({ peer: '127.0.0.1', encrypted: false, hasProxyHeaders: true })).toBe(true)
    expect(isTrustedLegacyTransport({ peer: '::1', encrypted: false, hasProxyHeaders: true })).toBe(true)
    // 私网其它主机带转发头不可信（防伪造来源）
    expect(isTrustedLegacyTransport({ peer: '192.168.1.5', encrypted: false, hasProxyHeaders: true })).toBe(false)
  })

  test('rejects public plaintext', () => {
    expect(isTrustedLegacyTransport({ peer: '203.0.113.7', encrypted: false, hasProxyHeaders: false })).toBe(false)
    expect(isTrustedLegacyTransport({ peer: '8.8.8.8', encrypted: false, hasProxyHeaders: true })).toBe(false)
  })
})
