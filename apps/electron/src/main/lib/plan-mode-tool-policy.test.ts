import { describe, expect, test } from 'bun:test'
import { createPlanModeToolPolicy, isBashCommandReadOnly } from './plan-mode-tool-policy'

describe('计划模式 Bash 只读判定', () => {
  test('Given 常见只读命令 When 判定 Then 允许', () => {
    for (const command of [
      'cat package.json',
      'sed -n 1,20p README.md',
      'find . -name "*.ts"',
      'ls -la',
      'rg TODO src',
      'git status',
      'git branch -a',
      'git branch --show-current',
      'git log --oneline -5',
      'git remote -v',
      'git tag -l',
    ]) {
      expect(isBashCommandReadOnly(command)).toBe(true)
    }
  })

  test('Given 写操作或执行原语 When 判定 Then 拒绝', () => {
    for (const command of [
      // git 写操作与带副作用的参数
      'git branch -D main',
      'git branch -d main',
      'git tag -d v1.0.0',
      'git remote set-url origin https://evil.example/x',
      'git diff --output=/tmp/x.patch',
      'git diff --output /tmp/x.patch',
      'git show --ext-diff HEAD',
      // 文件/搜索工具的副作用参数
      'file -C -m /tmp/magic',
      'tree -o /tmp/tree-out.txt',
      'rg --pre /tmp/evil.sh TODO .',
      'rg --pre=/bin/rm TODO .',
      'find . -fprint /tmp/out.txt',
      // 解释器内联执行
      'python3 -c "import os"',
      'node -e "process.exit(0)"',
      'perl -e "system(\'id\')"',
      'awk "BEGIN{system(\'id\')}"',
      'sh -c "id"',
      // 组合与重定向
      'echo hi > /tmp/a',
      'git log\nrm -rf /',
      'git status && rm -rf /',
      'ls | sh',
      // 外部执行/写文件原语
      'xargs rm',
      'tee /tmp/x',
      'open -a Calculator',
    ]) {
      expect(isBashCommandReadOnly(command)).toBe(false)
    }
  })

  test('Given 计划模式工具策略 When Bash 带 --output Then 拒绝', () => {
    const policy = createPlanModeToolPolicy('/tmp/session')
    expect(policy({ toolName: 'Bash', toolInput: { command: 'git diff --output=/tmp/x' } }))
      .toMatchObject({ behavior: 'deny' })
    expect(policy({ toolName: 'Bash', toolInput: { command: 'git status' } }))
      .toMatchObject({ behavior: 'allow' })
  })
})
