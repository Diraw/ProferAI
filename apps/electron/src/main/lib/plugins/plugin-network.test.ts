import { expect, mock, test } from 'bun:test'
let addresses = [{ address: '127.0.0.1', family: 4 }]
mock.module('node:dns/promises', () => ({ lookup: async () => addresses }))
mock.module('./plugin-permissions', () => ({ assertPluginOrigin: (_id: string, origin: string) => { if (origin !== 'https://example.com') throw new Error('未授权域名') } }))
const { isPublicPluginAddress, fetchPluginNetwork } = await import('./plugin-network')
test.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2002:7f00:1::'])('拒绝内网或保留 IP：%s', (address) => expect(isPublicPluginAddress(address)).toBe(false))
test('允许公共 IP', () => { expect(isPublicPluginAddress('1.1.1.1')).toBe(true); expect(isPublicPluginAddress('2606:4700:4700::1111')).toBe(true) })
test('域名解析到内网时在发出请求前拒绝，混合地址也拒绝', async () => {
  const input = { requestId: 'request', url: 'https://example.com/' }
  await expect(fetchPluginNetwork('plugin', input, new AbortController().signal)).rejects.toThrow('内网')
  addresses = [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]
  await expect(fetchPluginNetwork('plugin', input, new AbortController().signal)).rejects.toThrow('内网')
})
test('拒绝未授权域名、URL 凭据和伪造 Host 请求头', async () => {
  for (const input of [
    { url: 'https://other.example/' }, { url: 'https://user:secret@example.com/' }, { url: 'https://example.com/', headers: { Host: 'localhost' } },
  ]) await expect(fetchPluginNetwork('plugin', { requestId: 'request', ...input }, new AbortController().signal)).rejects.toThrow()
})
