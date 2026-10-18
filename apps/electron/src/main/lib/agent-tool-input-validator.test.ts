import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeToolInputForValidation, validateToolInput, validateToolPathPlatform, validateWriteTargetParent } from './agent-tool-input-validator'
import { validateWriteTargetParent as validateWriteTargetParentInClaudeProvider } from '@profer/agent-provider-claude/write-target-guard'

describe('agent tool input validation', () => {
  test('rejects a Windows absolute path on a non-Windows platform', () => {
    // 现场：模型把 `C:\Users\alex\dev\admin-console` 交给 LS，macOS 上 isAbsolute 为 false，
    // 路径被拼到会话目录后面，产生误导性的 "Path not found: …/session/C:\Users\alex\dev"。
    const failure = validateToolPathPlatform('LS', { path: 'C:\\Users\\alex\\dev\\admin-console' }, 'darwin')
    expect(failure?.behavior).toBe('deny')
    expect(failure?.message).toContain('Windows absolute path')
    expect(failure?.message).toContain('darwin')
  })

  test('covers forward-slash drive paths and both raw and canonical tool names', () => {
    expect(validateToolPathPlatform('Read', { file_path: 'C:/Users/maya/src/mobile-client' }, 'linux')?.behavior).toBe('deny')
    expect(validateToolPathPlatform('ls', { path: 'C:\\Users\\maya' }, 'darwin')?.behavior).toBe('deny')
  })

  test('does not touch Windows paths on Windows or POSIX paths everywhere', () => {
    expect(validateToolPathPlatform('LS', { path: 'C:\\Users\\alex\\dev' }, 'win32')).toBeNull()
    expect(validateToolPathPlatform('LS', { path: '/Users/mac/profer' }, 'darwin')).toBeNull()
    expect(validateToolPathPlatform('LS', { path: 'relative/dir' }, 'darwin')).toBeNull()
  })

  test('does not treat a colon-containing relative name as a drive path', () => {
    expect(validateToolPathPlatform('Grep', { pattern: 'C:/tmp' }, 'darwin')).toBeNull()
    expect(validateToolPathPlatform('Bash', { command: 'ls C:\\tmp' }, 'darwin')).toBeNull()
  })

  test('Claude Edit canonical input passes', () => {
    expect(validateToolInput('Edit', {
      file_path: 'src/example.ts',
      old_string: 'const before = 1',
      new_string: 'const after = 1',
    })).toBeNull()
  })

  test('Pi native Edit input is normalized before required-parameter validation', () => {
    const input = {
      path: 'src/example.ts',
      edits: [{ oldText: 'const before = 1', newText: 'const after = 1' }],
    }

    expect(normalizeToolInputForValidation('Edit', input)).toMatchObject({
      toolName: 'Edit',
      input: {
        file_path: 'src/example.ts',
        old_string: 'const before = 1',
        new_string: 'const after = 1',
      },
    })
    expect(validateToolInput('Edit', input)).toBeNull()
  })

  test('Pi MultiEdit input uses the same canonical validation and does not require top-level new_string', () => {
    expect(validateToolInput('MultiEdit', {
      path: 'src/example.ts',
      edits: [
        { oldText: 'const before = 1', newText: 'const after = 1' },
        { oldText: 'const other = 2', newText: 'const changed = 2' },
      ],
    })).toBeNull()
  })

  test('missing Pi nested newText reports the native field and recovery instruction', () => {
    const result = validateToolInput('Edit', {
      path: 'src/example.ts',
      edits: [{ oldText: 'const before = 1' }],
    })

    expect(result?.message).toContain('edits[0].newText')
    expect(result?.message).toContain('re-reading the current file')
    expect(result?.message).toContain('do not reuse oldText')
  })

  test('Pi Read and Write path is normalized to file_path', () => {
    expect(validateToolInput('Read', { path: 'src/example.ts' })).toBeNull()
    expect(validateToolInput('Write', { path: 'src/example.ts', content: 'content' })).toBeNull()
  })

  test('Write requires an existing parent directory and does not create it', () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'profer-write-guard-'))
    try {
      const existingParent = join(root, 'existing')
      const missingParent = join(root, 'missing')
      const parentFile = join(root, 'parent-file')
      mkdirSync(existingParent)
      writeFileSync(parentFile, 'not a directory')

      expect(validateWriteTargetParent({ path: 'existing/new.txt' }, root)).toBeNull()

      const missing = validateWriteTargetParent({ path: 'missing/new.txt' }, root)
      expect(missing?.behavior).toBe('deny')
      expect(missing?.message).toContain('parent directory does not exist')

      const nonDirectory = validateWriteTargetParent({ path: 'parent-file/new.txt' }, root)
      expect(nonDirectory?.behavior).toBe('deny')
      expect(nonDirectory?.message).toContain('parent directory does not exist')
      expect(() => statSync(missingParent)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Write parent guard ignores non-write tools', () => {
    expect(validateWriteTargetParent({ path: 'missing/new.txt' }, '/tmp', 'Read')).toBeNull()
  })

  test('unknown tools remain compatible', () => {
    expect(validateToolInput('CustomTool', {})).toBeNull()
  })
})

// GAP-7 E2 去重后，宿主导出与 Claude provider 导出是**同一个函数对象**，不再有第二份实现。
// 保留行为用例（上一 describe）作为契约回归；这里只锁定「单一来源」这个结构事实。
describe('Write parent guard：宿主与 provider 共享同一实现（E2 去重）', () => {
  test('Given 宿主导出 When 与 provider 子路径导出比较 Then 是同一个函数（不是等价副本）', () => {
    expect(validateWriteTargetParent).toBe(validateWriteTargetParentInClaudeProvider)
  })

  test('Given 宿主包声明 When 检查 provider 子路径导出 Then write-target-guard 已注册', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../../packages/agent-provider-claude/package.json', import.meta.url), 'utf8')) as {
      exports?: Record<string, string>
    }
    expect(manifest.exports?.['./write-target-guard']).toBe('./src/write-target-guard.ts')
  })
})
