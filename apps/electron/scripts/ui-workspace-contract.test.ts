import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uiRoot = resolve(appRoot, '../../packages/ui')
const configPath = resolve(appRoot, 'tailwind.config.js')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

// 实际编译 CSS，而不只断言配置里写了某个字符串。
describe('共享 UI 迁移后的工具链接线', () => {
  test('从仓库根目录编译时，仍生成 tooltip 的层级、主题和关闭动画', async () => {
    const result = await postcss([tailwindcss(configPath)])
      .process('@tailwind utilities;', { from: resolve(appRoot, 'src/renderer/styles/globals.css') })
    const selectors = new Set<string>()
    result.root.walkRules(rule => { selectors.add(rule.selector) })
    expect(selectors.has('.z-\\[10050\\]')).toBe(true)
    expect(selectors.has('.bg-tooltip\\/90')).toBe(true)
    expect(selectors.has('.data-\\[state\\=closed\\]\\:zoom-out-95[data-state="closed"]')).toBe(true)
  })

  test('shadcn 的 UI 与工具别名指向共享包，子路径可实际解析', () => {
    const appConfig = json(resolve(appRoot, 'components.json'))
    const uiConfig = json(resolve(uiRoot, 'components.json'))
    const appRequire = createRequire(resolve(appRoot, 'package.json'))
    expect(appConfig.aliases.ui).toBe('@profer/ui/primitives')
    expect(appConfig.aliases.utils).toBe('@profer/ui/lib/cn')
    expect(appRequire.resolve(`${appConfig.aliases.ui}/button`)).toBe(resolve(uiRoot, 'src/primitives/button.tsx'))
    expect(appRequire.resolve(appConfig.aliases.utils)).toBe(resolve(uiRoot, 'src/lib/cn.ts'))
    expect(appRequire.resolve(`${uiConfig.aliases.hooks}/use-smooth-zoom`)).toBe(resolve(uiRoot, 'src/hooks/use-smooth-zoom.ts'))
    expect(uiConfig.aliases.ui).toBe(appConfig.aliases.ui)
    expect(uiConfig.aliases.utils).toBe(appConfig.aliases.utils)
    expect(uiConfig.style).toBe(appConfig.style)
    expect(uiConfig.tailwind.baseColor).toBe(appConfig.tailwind.baseColor)
    expect(resolve(uiRoot, uiConfig.tailwind.config)).toBe(configPath)
    expect(resolve(uiRoot, uiConfig.tailwind.css)).toBe(resolve(appRoot, appConfig.tailwind.css))
  })
})
