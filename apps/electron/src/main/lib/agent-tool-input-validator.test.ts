import { describe, expect, test } from 'bun:test'
import { normalizeToolInputForValidation, validateToolInput, validateToolPathPlatform } from './agent-tool-input-validator'

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

  test('unknown tools remain compatible', () => {
    expect(validateToolInput('CustomTool', {})).toBeNull()
  })
})
