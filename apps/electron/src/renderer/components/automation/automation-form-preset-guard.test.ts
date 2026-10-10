import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 守卫：自动任务表单的预设下拉只能遍历可选列表，不能直接遍历原始 presets。
 * 原始列表包含明确停用的预设（enabledInWorkspace === false），直接渲染会让停用项可选。
 */
const source = readFileSync(resolve(import.meta.dir, 'AutomationFormView.tsx'), 'utf8')

test('预设下拉只渲染 selectablePresets，不直接渲染原始 presets', () => {
  expect(source).toContain('selectablePresets.map((preset) =>')
  expect(source).not.toContain('presets.map((preset) =>')
})

test('表单通过共享判定派生可选列表', () => {
  expect(source).toContain("import { selectableAgentPresets } from '@/components/agent/preset-selector-utils'")
  expect(source).toContain('selectableAgentPresets(presets)')
})
