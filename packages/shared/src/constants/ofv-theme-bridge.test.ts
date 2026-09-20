import { describe, expect, test } from 'bun:test'

import {
  OFV_THEME_TOKEN_NAMES,
  OFV_THEME_TOKENS_MAX_LENGTH,
  OFV_THEME_TOKEN_VALUE_MAX_LENGTH,
  isTrustedOfvThemeTokenValue,
  normalizeOfvThemePayload,
  parseOfvThemeTokens,
  sanitizeOfvThemeTokens,
  serializeOfvThemeTokens,
} from './ofv-theme-bridge'

describe('ofv-theme-bridge 载荷契约', () => {
  test('常见 token 值都能通过校验（HSL 三元组 / 完整颜色 / 长度 / 带 alpha）', () => {
    for (const value of [
      '0 0% 100%',
      '150 8% 14%',
      'hsl(145 35% 65% / 0.75)',
      'rgb(0 0 0 / 0.05)',
      '#0b1020',
      'oklch(0.7 0.1 200)',
      '0.625rem',
      '2px',
    ]) {
      expect(isTrustedOfvThemeTokenValue(value)).toBe(true)
    }
  })

  test('可疑值一律不通过：空串、超长、含分号/花括号/引号/反斜杠', () => {
    for (const value of [
      '',
      'x'.repeat(OFV_THEME_TOKEN_VALUE_MAX_LENGTH + 1),
      'red; background: url(http://evil)',
      'red} body{display:none',
      'red"',
      "red'",
      'red\\75 rl(assets/x.png)',
      'red\nnewline',
    ]) {
      expect(isTrustedOfvThemeTokenValue(value)).toBe(false)
    }
  })

  test('往返：序列化后解析出同一份 token（键序固定，供主进程做签名比对）', () => {
    const tokens = {
      background: '150 8% 14%',
      foreground: '140 10% 92%',
      radius: '2px',
      'selection-bg': 'hsl(145 35% 65% / 0.75)',
    }
    const serialized = serializeOfvThemeTokens(tokens)
    expect(serialized).not.toBeNull()
    expect(parseOfvThemeTokens(serialized)).toEqual(tokens)
    // 键序固定：同一份 token 两次序列化必须逐字相同
    expect(serializeOfvThemeTokens({ ...tokens })).toBe(serialized)
  })

  test('名单外的键被丢掉：页面拿不到任意自定义属性', () => {
    const parsed = parseOfvThemeTokens(JSON.stringify({ background: '0 0% 0%', 'evil-token': 'red' }))
    expect(parsed).toEqual({ background: '0 0% 0%' })
  })

  test('畸形载荷 fail closed：坏 JSON / 空 / 非法值都退回空对象', () => {
    expect(parseOfvThemeTokens(null)).toEqual({})
    expect(parseOfvThemeTokens(undefined)).toEqual({})
    expect(parseOfvThemeTokens('')).toEqual({})
    expect(parseOfvThemeTokens('{not json')).toEqual({})
    expect(parseOfvThemeTokens('"字符串不是对象"')).toEqual({})
    expect(parseOfvThemeTokens(JSON.stringify({ background: 'red} body{' }))).toEqual({})
  })

  test('极端合法载荷仍在长度上限内：上限只用于挡住外部畸形载荷', () => {
    // 名单内每个 token 都取到值上限，是序列化能产出的最大值
    const tokens = Object.fromEntries(
      OFV_THEME_TOKEN_NAMES.map((name) => [name, '1'.repeat(OFV_THEME_TOKEN_VALUE_MAX_LENGTH)]),
    )
    const serialized = serializeOfvThemeTokens(tokens)
    expect(serialized).not.toBeNull()
    expect(serialized!.length).toBeLessThanOrEqual(OFV_THEME_TOKENS_MAX_LENGTH)
  })

  test('全空 / 全非法时返回 null，调用方据此走主题默认色', () => {
    expect(serializeOfvThemeTokens({})).toBeNull()
    expect(serializeOfvThemeTokens({ background: 'red} body{' })).toBeNull()
    expect(sanitizeOfvThemeTokens(null)).toEqual({})
    expect(sanitizeOfvThemeTokens('字符串')).toEqual({})
  })

  test('超长载荷在解析入口就被拒（不进入 JSON.parse）', () => {
    expect(parseOfvThemeTokens(`{"background":"${'1'.repeat(OFV_THEME_TOKENS_MAX_LENGTH)}"}`)).toEqual({})
  })

  describe('normalizeOfvThemePayload（IPC 边界）', () => {
    test('只认 light/dark；非法明暗当作没给，但 token 照收', () => {
      expect(normalizeOfvThemePayload({ theme: 'light', tokens: { radius: '2px' } })).toEqual({
        theme: 'light',
        tokens: { radius: '2px' },
      })
      expect(normalizeOfvThemePayload({ theme: 'dark' })).toEqual({ theme: 'dark' })
      expect(normalizeOfvThemePayload({ theme: 'sepia', tokens: { radius: '2px' } })).toEqual({
        tokens: { radius: '2px' },
      })
    })

    test('两项都空 / 非对象输入返回 null（调用方据此不做任何重载）', () => {
      expect(normalizeOfvThemePayload(undefined)).toBeNull()
      expect(normalizeOfvThemePayload(null)).toBeNull()
      expect(normalizeOfvThemePayload('light')).toBeNull()
      expect(normalizeOfvThemePayload({})).toBeNull()
      expect(normalizeOfvThemePayload({ theme: 'sepia' })).toBeNull()
      expect(normalizeOfvThemePayload({ tokens: { 'evil-token': 'red' } })).toBeNull()
      expect(normalizeOfvThemePayload({ tokens: { background: 'red} body{' } })).toBeNull()
    })
  })
})
