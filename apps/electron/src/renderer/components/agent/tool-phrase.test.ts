import { describe, expect, test } from 'bun:test'
import { getToolPhrase } from './tool-phrase'

describe('命令类工具的行内短语', () => {
  test('Given Bash 命令 When 生成短语 Then 使用「执行」前缀', () => {
    const phrase = getToolPhrase('Bash', { command: 'ls -la' })
    expect(phrase.label).toBe('执行 ls -la')
    expect(phrase.loadingLabel).toBe('正在执行 ls -la...')
  })

  test('Given PowerShell 命令 When 生成短语 Then 与 Bash 同形态而不落到未知工具分支', () => {
    const command = 'Get-ChildItem -Path . -Recurse'
    const powerShell = getToolPhrase('PowerShell', { command })
    expect(powerShell).toEqual(getToolPhrase('Bash', { command }))
    expect(powerShell.label).toBe(`执行 ${command}`)
  })

  test('Given 超长命令 When 生成短语 Then 截断到 80 字符', () => {
    const command = 'x'.repeat(200)
    expect(getToolPhrase('PowerShell', { command }).label).toBe(`执行 ${'x'.repeat(80)}…`)
  })
})
