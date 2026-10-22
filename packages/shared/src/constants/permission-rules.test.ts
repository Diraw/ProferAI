import { describe, expect, test } from 'bun:test'
import {
  hasDangerousPowerShellStructure,
  hasDangerousStructure,
  isReadOnlyGitBashCommand,
  isSafeBashCommand,
  isSafePowerShellCommand,
} from './permission-rules'

describe('PowerShell permission rules', () => {
  test('Given simple metadata queries When classified Then they are auto-allowable', () => {
    expect(isSafePowerShellCommand('Get-Location')).toBe(true)
    expect(isSafePowerShellCommand('Get-Date')).toBe(true)
    expect(isSafePowerShellCommand('Get-Process -Name explorer')).toBe(true)
    expect(isSafePowerShellCommand('Get-Command git')).toBe(true)
    expect(isSafePowerShellCommand('Test-Path C:\\Windows')).toBe(true)
  })

  test('Given data reads, mutation, or composed scripts When classified Then they require approval', () => {
    expect(isSafePowerShellCommand('Get-Content $HOME\\.ssh\\id_rsa')).toBe(false)
    expect(isSafePowerShellCommand('Remove-Item C:\\temp\\x')).toBe(false)
    expect(isSafePowerShellCommand('Get-Location; Remove-Item C:\\temp\\x')).toBe(false)
    expect(isSafePowerShellCommand('Get-Process | Stop-Process')).toBe(false)
  })

  test('Given PowerShell-only composition syntax When checking structure Then it is considered dangerous', () => {
    expect(hasDangerousPowerShellStructure('Get-Location; Get-Date')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-Process | Select-Object Name')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-Item $(Get-Location)')).toBe(true)
    expect(hasDangerousPowerShellStructure('Get-ChildItem > out.txt')).toBe(true)
  })
})

describe('Bash permission rules', () => {
  test('Given read-only command shapes When classified Then they are auto-allowable', () => {
    for (const command of [
      'git status',
      'git status --short',
      'git log --oneline -5',
      'git log --grep="fix bug"',
      'git diff --stat',
      'git show HEAD',
      'git branch',
      'git branch -a',
      'git branch --show-current',
      'git branch --list "feat*"',
      'git remote -v',
      'git remote show origin',
      'git tag',
      'git tag -l',
      'git tag -l "v*"',
      'ls -la',
      'head -n 20 README.md',
      'tail -n 50 app.log',
      'grep -rn TODO src',
      'rg TODO src',
      'file image.png',
      'tree -L 2',
      'wc -l README.md',
      'npm ls',
      'npm view react version',
      'bun pm ls',
      'node --version',
      'bun --version',
    ]) {
      expect(isSafeBashCommand(command)).toBe(true)
    }
  })

  test('Given write or exec capable arguments When classified Then they require approval', () => {
    for (const command of [
      // git 写操作 / 带副作用的参数
      'git branch -D main',
      'git branch -d main',
      'git branch -m old new',
      'git branch new-branch',
      'git tag -d v1.0.0',
      'git tag v1.0.0',
      'git remote set-url origin https://evil.example/x',
      'git remote add origin https://evil.example/x',
      'git diff --output=/tmp/x.patch',
      'git diff --output /tmp/x.patch',
      'git diff --ext-diff',
      'git show --textconv HEAD',
      'git log --output=/tmp/x.log',
      'git -c core.pager=evil log',
      // 非 git 命令的副作用参数
      'rg --pre /tmp/evil.sh TODO .',
      'rg --pre=/bin/rm TODO .',
      'file -C -m /tmp/magic',
      'tree -o /tmp/tree-out.txt',
      // 解释器内联执行
      'node -e "require(\'child_process\').exec(\'id\')"',
      'python3 -c "import os"',
      'perl -e "system(\'id\')"',
      // 结构与拼接
      'git log\nrm -rf /',
      'git log $(rm -rf /)',
      'git log `id`',
      'git status &',
      'git status && rm -rf /',
      'git status; rm -rf /',
      'git log > /tmp/out',
      // 命令族外
      'cat ~/.ssh/id_rsa',
      'find . -delete',
      'npm exec evil',
    ]) {
      expect(isSafeBashCommand(command)).toBe(false)
    }
  })

  test('Given dangerous shell structure When checking Then composition and substitution are rejected', () => {
    expect(hasDangerousStructure('ls | sh')).toBe(true)
    expect(hasDangerousStructure('ls\nrm -rf /')).toBe(true)
    expect(hasDangerousStructure('ls $(id)')).toBe(true)
    expect(hasDangerousStructure('ls ${HOME}')).toBe(true)
    expect(hasDangerousStructure('ls <(id)')).toBe(true)
    expect(hasDangerousStructure('ls &')).toBe(true)
    expect(hasDangerousStructure('ls 2>&1')).toBe(true)
    expect(hasDangerousStructure('ls -la')).toBe(false)
  })

  test('Given git command When only checking git read-only shape Then non-git input is rejected', () => {
    expect(isReadOnlyGitBashCommand('git status')).toBe(true)
    expect(isReadOnlyGitBashCommand('git branch -D main')).toBe(false)
    expect(isReadOnlyGitBashCommand('ls -la')).toBe(false)
    expect(isReadOnlyGitBashCommand('git log --format="%h %s"')).toBe(true)
  })
})
