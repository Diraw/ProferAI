/**
 * 读出 app 文档上**实际生效**的 Profer token 值，交给浏览器列里的 viewer 页。
 *
 * 为什么不是照抄 `globals.css` 的默认值：真正决定观感的是"此刻生效的变量"——
 * 皮肤通过 `<style id="skin-css">` 覆写 `:root`，用户皮肤还可能直接改别名
 * （`--panel-surface: var(--raised-surface)` 这类派生链由 `getComputedStyle` 展开）。
 * 读计算值意味着：默认主题、内置皮肤、用户自定义皮肤都走同一条路径，
 * 不需要在预览侧维护任何皮肤清单。
 *
 * 名单与校验在 `@profer/shared` 的 ofv-theme-bridge（跨进程契约，单一真源）；
 * 名单是否覆盖 `ofv-profer-theme.css` 真正消费的变量，由同目录的漂移守卫测试守住。
 */
import { OFV_THEME_TOKEN_NAMES, type OfvThemeTokens } from '@profer/shared'

/** 只需要能按名字取值，便于单测注入替身（不引入 DOM 环境依赖） */
export interface OfvTokenValueSource {
  getPropertyValue(property: string): string
}

/**
 * 从样式源收集 token：**只收有值的项**。
 * 留空 = 该 token 在当前主题下未定义（如默认主题没有 `--selection-bg`），
 * 页面侧的 `var(--x, fallback)` 才会走到主题自己的默认分支。
 */
export function collectOfvThemeTokens(source: OfvTokenValueSource): OfvThemeTokens {
  const tokens: OfvThemeTokens = {}
  for (const name of OFV_THEME_TOKEN_NAMES) {
    const value = source.getPropertyValue(`--${name}`).trim()
    if (value) tokens[name] = value
  }
  return tokens
}

/** 读 app 文档 `:root` 的计算值（调用前需确认皮肤 CSS 已落定，见 atoms/theme 的 whenSkinCssApplied） */
export function readOfvThemeTokens(): OfvThemeTokens {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return {}
  return collectOfvThemeTokens(window.getComputedStyle(document.documentElement))
}
