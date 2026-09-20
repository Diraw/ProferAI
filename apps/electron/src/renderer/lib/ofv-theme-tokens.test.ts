import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { OFV_THEME_TOKEN_NAMES } from '@profer/shared'

import { collectOfvThemeTokens } from './ofv-theme-tokens'

/**
 * 漂移守卫：`ofv-profer-theme.css` 与搬运名单必须严格对齐。
 *
 * 背景：viewer 独立页（浏览器列里的文件预览）拿不到 app 文档的 CSS 变量，只能靠主进程把
 * 「实际生效的 token 值」烘进 URL。所以 CSS 里每多消费一个 Profer token，就必须同时进名单
 * —— 否则预览页那一处映射会退化成 `var()` 未定义（OFV 默认蓝调），而且不会有任何报错。
 * 反向同理：名单里的死条目只会白占 URL 长度，并让人误以为预览页拿到了并不需要的东西。
 */
const BRIDGE_CSS_URL = new URL('../styles/ofv-profer-theme.css', import.meta.url)

describe('OFV 主题桥接：CSS 与搬运名单对齐', () => {
  test('桥接 CSS 消费的 Profer token 与 OFV_THEME_TOKEN_NAMES 完全一致（双向）', () => {
    // 先去掉注释：注释里也会出现 var(--x) 这种示例写法，不该被当成真实消费
    const css = readFileSync(BRIDGE_CSS_URL, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
    const consumed = new Set<string>()
    for (const match of css.matchAll(/var\(--([a-z0-9-]+)/g)) {
      const name = match[1]!
      // --ofv-* 是桥接自己产出的内部变量（映射结果），不是要搬运的 Profer token
      if (name.startsWith('ofv-')) continue
      consumed.add(name)
    }
    expect([...consumed].sort()).toEqual([...OFV_THEME_TOKEN_NAMES].sort())
  })

  test('取值只收有值的 token：当前主题未定义的项（如默认主题的 --selection-bg）不补空串', () => {
    const values: Record<string, string> = {
      '--background': '150 8% 14%',
      '--radius': '2px',
      '--selection-bg': '',
    }
    expect(collectOfvThemeTokens({ getPropertyValue: (name) => values[name] ?? '' })).toEqual({
      background: '150 8% 14%',
      radius: '2px',
    })
  })

  test('取值去掉前后空白（getComputedStyle 返回的原始值可能带空格）', () => {
    expect(
      collectOfvThemeTokens({ getPropertyValue: (name) => (name === '--foreground' ? '  140 10% 92%  ' : '') }),
    ).toEqual({ foreground: '140 10% 92%' })
  })
})
