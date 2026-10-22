import { describe, expect, test } from 'bun:test'
import { resolveEditionBearerToken } from './contract'

describe('发行版能力契约', () => {
  test('代管凭据优先使用 proxyToken', () => {
    expect(resolveEditionBearerToken({ baseUrl: 'https://team.example', token: 'jwt', proxyToken: 'relay' })).toBe('relay')
  })

  test('没有 proxyToken 时回退到 access token', () => {
    expect(resolveEditionBearerToken({ baseUrl: 'https://team.example', token: 'jwt' })).toBe('jwt')
  })
})
