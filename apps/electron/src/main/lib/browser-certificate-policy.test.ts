import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Certificate } from 'electron'
import {
  chainContainsDistrustedCertificate,
  DISTRUSTED_SPKI_SHA256,
  getDistrustedSpkiHashes,
  isDistrustedSpkiHash,
  mergeDistrustedSpkiHashes,
  parseDistrustedSpkiFeed,
  readDistrustedSpkiCache,
  refreshDistrustedSpkiHashes,
  resetDistrustedSpkiHashesForTest,
  spkiSha256FromPem,
} from './browser-certificate-policy'

/** 本地自签测试证书，只用于验证 SPKI 提取与链遍历，不含任何真实站点信息。 */
const TEST_PEM = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUIxGDcC0ZG3kmd3JngATHQpD0CBgwDQYJKoZIhvcNAQEL
BQAwIjEgMB4GA1UEAwwXcHJvZmVyLWNlcnQtcG9saWN5LXRlc3QwHhcNMjYxMDIx
MTYyMDU2WhcNMzYxMDE4MTYyMDU2WjAiMSAwHgYDVQQDDBdwcm9mZXItY2VydC1w
b2xpY3ktdGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALGkB3hb
khfHxrE168+nPSsq8LYegptdhxN43CkA9Ww+IrRfEGRT15xYHMcgiCBj8AP33gMV
45XpDQi9F//TddKvnTdGGI3LC0qmuKoyLVl4PAYFl9MkYYXcH5oJYH41sPYMdaGY
ENVftj/H07im2Lb1pDZfgzJJ7f6VzICxIJ7xWbdH0CDNFdMuVxN8yCEbrCJZAM0v
2mqawdaA7bydv328YP66SkwzBFATALdLElQsqIF4POg2y6NY+6Ml5cZUJOjSCy7h
3Y/9DFNpO3JayK0yqdhzwAkaT2DwB0rfOYlSnFz7L5qSYUhJmN6KHyVNpPHHg5q4
zsY0M7GdgSVB56cCAwEAAaNTMFEwHQYDVR0OBBYEFJuTpnebK+z0nnnzJ5Px/tS3
UogkMB8GA1UdIwQYMBaAFJuTpnebK+z0nnnzJ5Px/tS3UogkMA8GA1UdEwEB/wQF
MAMBAf8wDQYJKoZIhvcNAQELBQADggEBAD7oYWMeQm2LbvGk7Xyxswlpuof3cMkt
Of/jq7M7lsPQ5y7tfLGPfuRfMj5ogjudRGbEu6uPb1ob+6F1i3Y0DpD1wB951993
rQvAew6/0u7SsiBWlmgp4bVoQnzFIIv+NHthrpa6UPyp0MsszZNqn3+c4hnYJznR
byRYIC2dFJLjbxPhbELKNXOmazdAQNFOA2P6x+5hA0OqfxzVxQBYEFCqf5hWu9/A
pJealw9EDdErt2ygUp2rBi/GZCqcDqTyqzquDmiKanKrR+rnVU24sIClWxm1ZYdO
1zDlQbPcvpZV3/5h9eFMCzuQOnHmbBFJuaRC0BvtRu7ywuxK9pUiThw=
-----END CERTIFICATE-----`

const TEST_HASH = spkiSha256FromPem(TEST_PEM) as string
const REMOTE_HASH = 'a'.repeat(64)

function cert(data: string, issuerCert?: Certificate): Certificate {
  return { data, issuerCert } as unknown as Certificate
}

afterEach(() => {
  resetDistrustedSpkiHashesForTest()
})

describe('受管浏览器证书黑名单', () => {
  test('覆盖 eMudhra 八张中间 CA，且都是合法 SHA-256', () => {
    expect(DISTRUSTED_SPKI_SHA256.size).toBe(8)
    for (const hash of DISTRUSTED_SPKI_SHA256) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('SPKI 提取对合法证书稳定、对非法输入返回 null', () => {
    expect(TEST_HASH).toMatch(/^[0-9a-f]{64}$/)
    expect(spkiSha256FromPem(TEST_PEM)).toBe(TEST_HASH)
    expect(spkiSha256FromPem('not a certificate')).toBeNull()
  })

  test('命中判定大小写不敏感，null 安全', () => {
    expect(isDistrustedSpkiHash(TEST_HASH, new Set([TEST_HASH]))).toBe(true)
    expect(isDistrustedSpkiHash(TEST_HASH.toUpperCase(), new Set([TEST_HASH]))).toBe(true)
    expect(isDistrustedSpkiHash(null)).toBe(false)
    expect(isDistrustedSpkiHash(TEST_HASH)).toBe(false)
  })

  test('issuer 链中任意一张命中都拒绝，未知证书放行', () => {
    const distrusted = new Set([TEST_HASH])
    expect(chainContainsDistrustedCertificate(cert(TEST_PEM), distrusted)).toBe(true)
    expect(chainContainsDistrustedCertificate(cert(TEST_PEM, cert(TEST_PEM)), distrusted)).toBe(true)
    expect(chainContainsDistrustedCertificate(cert(TEST_PEM), new Set(['0'.repeat(64)]))).toBe(false)
    expect(chainContainsDistrustedCertificate(null)).toBe(false)
    expect(chainContainsDistrustedCertificate(undefined)).toBe(false)
  })

  test('链出现循环引用时不会死循环', () => {
    const leaf = cert(TEST_PEM)
    const issuer = cert(TEST_PEM, leaf)
    ;(leaf as unknown as { issuerCert: Certificate }).issuerCert = issuer
    expect(chainContainsDistrustedCertificate(leaf, new Set(['0'.repeat(64)]))).toBe(false)
  })
})

describe('远程黑名单', () => {
  test('解析对象/数组载荷，过滤非法项并去重', () => {
    expect(parseDistrustedSpkiFeed({ spkiSha256: [REMOTE_HASH, REMOTE_HASH.toUpperCase(), 'bad', 42] }))
      .toEqual([REMOTE_HASH])
    expect(parseDistrustedSpkiFeed([REMOTE_HASH])).toEqual([REMOTE_HASH])
    expect(() => parseDistrustedSpkiFeed({ spkiSha256: [] })).toThrow('证书黑名单为空')
    expect(() => parseDistrustedSpkiFeed({ spkiSha256: 'nope' })).toThrow('证书黑名单格式无效')
    expect(() => parseDistrustedSpkiFeed(null)).toThrow('证书黑名单格式无效')
  })

  test('合并时基线永不丢失，远程项追加', () => {
    mergeDistrustedSpkiHashes([REMOTE_HASH, 'not-a-hash'])
    const active = getDistrustedSpkiHashes()
    expect(active.size).toBe(9)
    expect(active.has(REMOTE_HASH)).toBe(true)
    for (const baseline of DISTRUSTED_SPKI_SHA256) expect(active.has(baseline)).toBe(true)
  })

  test('远程刷新成功时合并并写缓存，失败时抛错且不污染基线', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'profer-cert-feed-'))
    const cacheFile = join(directory, 'feed.json')
    try {
      const okFetch = (async () => new Response(JSON.stringify({ spkiSha256: [REMOTE_HASH] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
      await expect(refreshDistrustedSpkiHashes({ cacheFile, fetchImpl: okFetch })).resolves.toEqual({ count: 1 })
      expect(getDistrustedSpkiHashes().has(REMOTE_HASH)).toBe(true)
      expect(readDistrustedSpkiCache(cacheFile)).toEqual([REMOTE_HASH])
      expect(JSON.parse(readFileSync(cacheFile, 'utf-8')).spkiSha256).toEqual([REMOTE_HASH])

      resetDistrustedSpkiHashesForTest()
      const failFetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
      await expect(refreshDistrustedSpkiHashes({ fetchImpl: failFetch })).rejects.toThrow('HTTP 503')
      expect(getDistrustedSpkiHashes().size).toBe(8)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('缓存损坏时返回 null，不抛出', () => {
    const directory = mkdtempSync(join(tmpdir(), 'profer-cert-cache-'))
    try {
      const cacheFile = join(directory, 'broken.json')
      expect(readDistrustedSpkiCache(cacheFile)).toBeNull()
      expect(readDistrustedSpkiCache(join(directory, 'missing.json'))).toBeNull()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
