import { describe, expect, test } from 'bun:test'
import { assertSafeBrowserUrl, isSafeBrowserSubresourceUrl, normalizeBrowserUrl } from './browser-policy'

describe('受管浏览器 URL 策略', () => {
  test('规范化常见地址栏输入为可导航的 HTTPS URL', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrl('//example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserUrl('example.com:8443/docs')).toBe('https://example.com:8443/docs')
  })

  test('允许明确指定的本机开发地址，同时拒绝其他私网目标', () => {
    expect(assertSafeBrowserUrl('https://example.com/')).toBe('https://example.com/')
    expect(assertSafeBrowserUrl('http://example.com/')).toBe('http://example.com/')
    expect(assertSafeBrowserUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
    expect(assertSafeBrowserUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(assertSafeBrowserUrl('http://[::1]:3000')).toBe('http://[::1]:3000/')
    expect(assertSafeBrowserUrl('http://192.168.1.10:8080')).toBe('http://192.168.1.10:8080/')
    expect(assertSafeBrowserUrl('http://dev-machine.local:3000')).toBe('http://dev-machine.local:3000/')
    expect(() => assertSafeBrowserUrl('file:///tmp/index.html')).toThrow('不允许此 URL 协议')
    expect(() => assertSafeBrowserUrl('javascript:alert(1)')).toThrow('不允许此 URL 协议')
    expect(() => assertSafeBrowserUrl('https://user:pass@example.com')).toThrow('认证信息')
  })

  test('本地开发地址缺省使用 HTTP，公网地址缺省使用 HTTPS', () => {
    expect(normalizeBrowserUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(normalizeBrowserUrl('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(normalizeBrowserUrl('//127.0.0.1:4173')).toBe('http://127.0.0.1:4173')
    expect(normalizeBrowserUrl('example.com:8443/docs')).toBe('https://example.com:8443/docs')
  })

  test('子资源使用同步策略，并允许本地开发服务加载依赖', () => {
    expect(isSafeBrowserSubresourceUrl('https://cdn.example.com/app.js')).toBe(true)
    expect(isSafeBrowserSubresourceUrl('http://127.0.0.1:3000/app.js')).toBe(true)
    expect(isSafeBrowserSubresourceUrl('http://localhost:5173/@vite/client')).toBe(true)
    expect(isSafeBrowserSubresourceUrl('https://192.168.1.10/app.js')).toBe(true)
    expect(isSafeBrowserSubresourceUrl('data:text/plain,ok')).toBe(false)
    expect(isSafeBrowserSubresourceUrl('not a url')).toBe(false)
  })
})
