/**
 * Open File Viewer 主题桥接：**跨进程载荷契约**（单一真源）。
 *
 * 背景：浏览器列里的文件预览跑在一个**无 preload** 的沙箱 webContents（viewer 页）里，
 * 它读不到 app 的主题设置，也读不到 app 文档上的 CSS 变量（`prefers-color-scheme` 反映的是 OS，
 * 不是 app 里选的主题/皮肤）。所以主题只能在打开时"烘"进 URL，而 URL 里能带的就是这些 token 值。
 *
 * 三方共用本文件：
 * - 渲染进程 `lib/ofv-theme-tokens.ts`：从 app 文档算出实际生效的 token 值；
 * - 主进程 `browser-preview-service` / `browser-controller`：校验、记忆、拼进 viewer URL；
 * - viewer 页 `viewer/main.ts`（以及 `viewer.html` 的首帧脚本）：解析并写回页面。
 *
 * 为什么传**值**而不是皮肤 id / 皮肤 CSS：
 * 1. 预览面的观感契约是"配色跟随主题，排版与 app 特效不跟随"（见 `ofv-profer-theme.css`）。
 *    传值只搬运颜色/几何，天然不会把皮肤的扫描线、辉光、`button{}` 这类 app 专属规则带进预览面；
 * 2. 不需要把皮肤目录或 CSS 文本交给一个正在渲染**不可信文档**的页面，攻击面不扩大；
 * 3. 皮肤换色不必枚举皮肤 id，用户自定义皮肤、以及"两个深色皮肤互相切换"同样自动跟上。
 *
 * 代价：token 名单必须与 `ofv-profer-theme.css` 里实际消费的变量保持一致 —— 由
 * `apps/electron/src/renderer/lib/ofv-theme-tokens.test.ts` 的漂移守卫测试守住。
 */

/**
 * 会被搬运到 viewer 页的 Profer token。
 *
 * 取值口径是「app 文档上 `:root` 的**计算值**」（自定义属性会把 `var()` 展开），
 * 所以像 `--panel-surface: var(--raised-surface)` 这种别名也会被展开成最终值，
 * viewer 页不需要再复制 app 的派生链。
 *
 * 名单**恰好等于** `ofv-profer-theme.css` 消费的那组变量（多一个少一个都会被漂移守卫测试拦下）：
 * viewer 页只搬运这份名单，所以任何被映射消费、却不在名单里的 token 在预览页都会失效。
 */
export const OFV_THEME_TOKEN_NAMES = [
  'radius',
  'background',
  'foreground',
  'muted',
  'muted-foreground',
  'raised-surface',
  'surface-border',
  'panel-surface',
  'panel-border',
  'primary',
  'selection-bg',
  'selection-color',
] as const

export type OfvThemeTokenName = (typeof OFV_THEME_TOKEN_NAMES)[number]

/**
 * 只带出现的 token：默认主题没有的皮肤专属 token（如 `--selection-bg`）不写空串。
 * 值口径是 app 文档上的**计算值**（HSL 三元组 / 长度值），不是经过包装的完整颜色。
 */
export type OfvThemeTokens = Partial<Record<OfvThemeTokenName, string>>

/** 单个 token 值的长度上限（正常的 HSL 三元组/长度值在 10~40 字符内，超出即视为畸变） */
export const OFV_THEME_TOKEN_VALUE_MAX_LENGTH = 64

/** 整份序列化载荷的长度上限（实测约 300 字符；超限即整体丢弃，不把畸形长串塞进导航 URL） */
export const OFV_THEME_TOKENS_MAX_LENGTH = 2048

/**
 * token 值的允许字符：颜色值与长度值所需的数字、单位、括号、百分号、斜杠、点、逗号、空白。
 * 刻意不含 `;` `{}` `"` `'` `\` `<` `>` —— 值最终是要写进 CSS 的，这里做一层字符白名单兜底。
 */
const TOKEN_VALUE_RE = /^[#a-zA-Z0-9(),.%/\t -]+$/

/** 预览面接受的两种明暗（与 OFV 自己的 `theme` 选项一致） */
export const OFV_PREVIEW_THEMES = ['light', 'dark'] as const
export type OfvPreviewTheme = (typeof OFV_PREVIEW_THEMES)[number]

/** 一个预览（或一次主题同步）应携带的主题参数；两项都缺省时页面走主题默认色 */
export interface OfvThemePayload {
  theme?: OfvPreviewTheme
  tokens?: OfvThemeTokens
}

/**
 * IPC / URL 边界：把未知输入收敛成可信的主题参数。
 *
 * 两项都会以 URL 查询参数进到一个渲染**不可信文档**的页面里，所以在边界上一次性收口：
 * theme 只认 light/dark；tokens 走名单 + 字符白名单。两项都空时返回 null，
 * 调用方据此不做任何重载（而不是把已打开预览刷成默认色）。
 */
export function normalizeOfvThemePayload(input: unknown): OfvThemePayload | null {
  if (!input || typeof input !== 'object') return null
  const source = input as { theme?: unknown; tokens?: unknown }
  const theme = OFV_PREVIEW_THEMES.find((candidate) => candidate === source.theme)
  const tokens = sanitizeOfvThemeTokens(source.tokens)
  if (!theme && isEmptyOfvThemeTokens(tokens)) return null
  return { ...(theme ? { theme } : {}), ...(isEmptyOfvThemeTokens(tokens) ? {} : { tokens }) }
}

/** 单个 token 值是否可信（同时挡住空串与超长值） */
export function isTrustedOfvThemeTokenValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= OFV_THEME_TOKEN_VALUE_MAX_LENGTH &&
    TOKEN_VALUE_RE.test(value)
  )
}

/** 任意输入 → 只保留名单内、值可信的 token（不抛异常，供两端解析不可信载荷） */
export function sanitizeOfvThemeTokens(input: unknown): OfvThemeTokens {
  if (!input || typeof input !== 'object') return {}
  const source = input as Record<string, unknown>
  const tokens: OfvThemeTokens = {}
  for (const name of OFV_THEME_TOKEN_NAMES) {
    const value = source[name]
    if (isTrustedOfvThemeTokenValue(value)) tokens[name] = value
  }
  return tokens
}

/** token 数是否为空（空 = 没有可搬运的值，调用方应回退到主题自身的默认着色） */
export function isEmptyOfvThemeTokens(tokens: OfvThemeTokens): boolean {
  return Object.keys(tokens).length === 0
}

/**
 * 序列化成 URL 参数值。
 *
 * 键序固定按 `OFV_THEME_TOKEN_NAMES`：主进程要拿这串做"是否已经烘进当前 URL"的比对，
 * 同一个主题必须得到同一个字符串，否则每次同步都会误判成变化而重载预览。
 * 返回 null 表示没有可搬运的值 / 超出长度上限。
 */
export function serializeOfvThemeTokens(tokens: OfvThemeTokens): string | null {
  const safe = sanitizeOfvThemeTokens(tokens)
  if (isEmptyOfvThemeTokens(safe)) return null
  const ordered: Record<string, string> = {}
  for (const name of OFV_THEME_TOKEN_NAMES) {
    const value = safe[name]
    if (value) ordered[name] = value
  }
  const serialized = JSON.stringify(ordered)
  return serialized.length > OFV_THEME_TOKENS_MAX_LENGTH ? null : serialized
}

/**
 * 解析 URL 参数里的载荷。畸形 JSON / 未知 token / 可疑值一律丢弃（fail closed），
 * 页面侧宁可用主题默认色，也不把来源不明的字符串写进 CSS。
 */
export function parseOfvThemeTokens(raw: string | null | undefined): OfvThemeTokens {
  if (!raw || raw.length > OFV_THEME_TOKENS_MAX_LENGTH) return {}
  try {
    return sanitizeOfvThemeTokens(JSON.parse(raw))
  } catch {
    return {}
  }
}
