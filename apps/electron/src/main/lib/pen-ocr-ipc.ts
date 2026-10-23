/**
 * 手写笔 OCR —— 把墨迹图片识别成文字
 *
 * 两个平台都只用「系统自带能力」，不打包模型、不联网：
 * - macOS：Vision（VNRecognizeTextRequest），编译成 resources/bin/pen-ocr
 * - Windows：Windows.Media.Ocr（WinRT），由 resources/pen-ocr/PenOcr.ps1 驱动
 *
 * 调用点只有 recognizeHandwriting 一处，将来换 MyScript / 视觉模型也只改这里。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'

export interface PenOcrResult {
  /** 识别出的文本；失败时为空串 */
  text: string
  /** 失败原因，供渲染进程决定提示文案 */
  error?: 'unsupported-platform' | 'helper-missing' | 'recognize-failed'
}

const PNG_DATA_URL_PREFIX = /^data:image\/png;base64,/

/** 开发态取 app 目录，打包态取 resourcesPath */
function resolveBundledResource(...segments: string[]): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'resources', ...segments),
    app.isPackaged ? join(process.resourcesPath, ...segments) : '',
  ].filter((candidate): candidate is string => candidate.length > 0)
  return candidates.find((candidate) => existsSync(candidate))
}

function runCommand(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) {
        resolve()
        return
      }
      const message = typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim() : error.message
      const wrapped = new Error(message) as NodeJS.ErrnoException
      // 保留 errno：调用方要靠 ENOENT 判断「powershell 不在 PATH」
      wrapped.code = (error as NodeJS.ErrnoException).code
      reject(wrapped)
    })
  })
}

/** macOS：调用随包的 Vision 小工具 */
async function recognizeOnMac(imagePath: string): Promise<string> {
  const helper = resolveBundledResource('bin', 'pen-ocr')
  if (!helper) throw new Error('pen-ocr helper missing')

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(helper, [imagePath], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, out, err) => {
      if (error) {
        reject(new Error(typeof err === 'string' && err.length > 0 ? err : error.message))
        return
      }
      resolve(out)
    })
  })
  return stdout.trim()
}

/**
 * Windows：Windows.Media.Ocr。
 *
 * 结果写临时文件而不是读 stdout —— PowerShell 5.1 在重定向时的编码不可控，
 * 中文很容易变乱码。
 */
async function recognizeOnWindows(imagePath: string, workDir: string): Promise<string> {
  const script = resolveBundledResource('pen-ocr', 'PenOcr.ps1')
  if (!script) throw new Error('PenOcr.ps1 missing')

  const outFile = join(workDir, 'ocr.txt')
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Path',
    imagePath,
    '-OutFile',
    outFile,
  ]

  try {
    await runCommand('powershell.exe', args, 20_000)
  } catch (error) {
    // 少数环境 PATH 里没有 powershell.exe，回退到系统绝对路径
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !process.env.SystemRoot) throw error
    const absolute = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    await runCommand(absolute, args, 20_000)
  }

  if (!existsSync(outFile)) return ''
  return (await readFile(outFile, 'utf8')).trim()
}

export async function recognizeHandwriting(pngBase64: string): Promise<PenOcrResult> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { text: '', error: 'unsupported-platform' }
  }

  const payload = pngBase64.replace(PNG_DATA_URL_PREFIX, '')
  if (payload.length === 0) return { text: '', error: 'recognize-failed' }

  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'profer-pen-ocr-'))
    const imagePath = join(dir, 'ink.png')
    await writeFile(imagePath, Buffer.from(payload, 'base64'))

    const text = process.platform === 'darwin'
      ? await recognizeOnMac(imagePath)
      : await recognizeOnWindows(imagePath, dir)

    return { text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[pen-ocr] 识别失败:', error)
    return { text: '', error: message.includes('missing') ? 'helper-missing' : 'recognize-failed' }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function registerPenOcrIpc(): void {
  ipcMain.handle('pen:recognize', async (_event, pngBase64: string): Promise<PenOcrResult> => {
    if (typeof pngBase64 !== 'string') return { text: '', error: 'recognize-failed' }
    return recognizeHandwriting(pngBase64)
  })
}
