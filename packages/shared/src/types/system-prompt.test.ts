import { describe, expect, test } from 'bun:test'
import { BUILTIN_DEFAULT_PROMPT_STRING } from './system-prompt'

describe('内置默认提示词', () => {
  test('包含公式输出契约，避免价格与 shell 变量被误解析', () => {
    expect(BUILTIN_DEFAULT_PROMPT_STRING).toContain('数学公式规范')
    expect(BUILTIN_DEFAULT_PROMPT_STRING).toContain('行内公式用 $...$')
    expect(BUILTIN_DEFAULT_PROMPT_STRING).toContain('块级公式用 $$...$$ 并独占行')
    expect(BUILTIN_DEFAULT_PROMPT_STRING).toContain('字面美元符号前加反斜杠转义')
  })
})
