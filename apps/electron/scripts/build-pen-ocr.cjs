#!/usr/bin/env node
/**
 * 编译手写笔 OCR 小工具（macOS Vision）。
 *
 * 产物：resources/bin/pen-ocr，由 electron-builder extraResources 带进 bin/pen-ocr。
 * 非 macOS 平台直接跳过——渲染进程在识别不可用时会回退成图片附件。
 */

const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') {
  console.log('[pen-ocr] 非 macOS 平台，跳过编译')
  process.exit(0)
}

const root = join(__dirname, '..')
const source = join(root, 'resources', 'pen-ocr', 'PenOcr.swift')
const output = join(root, 'resources', 'bin', 'pen-ocr')

mkdirSync(join(root, 'resources', 'bin'), { recursive: true })

// 源码没变就不重编译。
// macOS 上「新出现的未签名二进制」第一次执行会被系统安全扫描，实测要 30s 左右；
// 每次 dev 启动都重编译，就等于每次首识别都要等半分钟。
const force = process.argv.includes('--force')
if (!force && existsSync(output) && statSync(output).mtimeMs > statSync(source).mtimeMs) {
  console.log('[pen-ocr] 已是最新，跳过编译')
  process.exit(0)
}

const result = spawnSync(
  'swiftc',
  ['-O', '-o', output, source, '-framework', 'Vision', '-framework', 'AppKit'],
  { stdio: 'inherit' },
)

if (result.error) {
  console.error('[pen-ocr] 无法执行 swiftc（需要 Xcode Command Line Tools）:', result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  console.error('[pen-ocr] swiftc 编译失败')
  process.exit(result.status ?? 1)
}

console.log('[pen-ocr] built', output)
