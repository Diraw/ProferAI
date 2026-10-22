/**
 * MCP 服务器验证器测试
 *
 * 重点回归：stdio 命令来自 renderer 可写的 MCP 配置，检查命令是否存在时
 * 不得经过 shell 解析，否则 `node; touch x` 这类配置会产生命令注入副作用。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateMcpServer } from './mcp-validator'

const scratchDir = mkdtempSync(join(tmpdir(), 'profer-mcp-validator-'))

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true })
})

describe('validateMcpServer：stdio 命令校验', () => {
  test('Given 命令是本机存在的 node When 校验 Then 通过', async () => {
    const result = await validateMcpServer('local', {
      type: 'stdio',
      command: 'node',
      enabled: true,
    })
    expect(result).toEqual({ name: 'local', valid: true })
  })

  test('Given 命令是绝对路径且文件存在 When 校验 Then 通过', async () => {
    const result = await validateMcpServer('absolute', {
      type: 'stdio',
      command: process.execPath,
      enabled: true,
    })
    expect(result.valid).toBe(true)
  })

  test('Given 命令含 shell 分隔符注入 When 校验 Then 判为不可用且无 shell 副作用', async () => {
    const pwned = join(scratchDir, 'pwned')
    const result = await validateMcpServer('injected', {
      type: 'stdio',
      command: `node; touch ${pwned}`,
      enabled: true,
    })

    expect(result.valid).toBe(false)
    // 关键断言：旧实现用 execSync 拼串，touch 会被真正执行
    expect(existsSync(pwned)).toBe(false)
  })

  test('Given 命令含换行 When 校验 Then 判为不可用', async () => {
    const pwned = join(scratchDir, 'pwned-newline')
    const result = await validateMcpServer('injected-newline', {
      type: 'stdio',
      command: `node\ntouch ${pwned}`,
      enabled: true,
    })

    expect(result.valid).toBe(false)
    expect(existsSync(pwned)).toBe(false)
  })

  test('Given 命令为空串 When 校验 Then 判为不可用', async () => {
    const result = await validateMcpServer('empty', {
      type: 'stdio',
      command: '',
      enabled: true,
    })
    expect(result.valid).toBe(false)
  })

  test('Given 绝对路径不存在 When 校验 Then 判为不可用', async () => {
    const missing = join(scratchDir, 'not-installed', 'definitely-not-a-binary')
    const result = await validateMcpServer('missing', {
      type: 'stdio',
      command: missing,
      enabled: true,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('命令不存在或不可执行')
  })
})
