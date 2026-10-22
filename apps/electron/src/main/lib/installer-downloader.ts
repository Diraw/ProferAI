/**
 * 第三方安装包下载器
 *
 * 从 OSS / 官方源下载 Git、Node.js 安装程序到本地临时目录，
 * 下载过程中通过 BrowserWindow 事件推送进度，完成后校验 sha256。
 */

import { createHash } from 'crypto'
import { createWriteStream, existsSync, promises as fsp, realpathSync, statSync } from 'fs'
import { get as httpsGet } from 'https'
import { get as httpGet, IncomingMessage } from 'http'
import path from 'path'
import { URL } from 'url'

import { app, BrowserWindow, shell } from 'electron'

import {
  INSTALLER_IPC_CHANNELS,
  type InstallerDownloadResult,
  type InstallerProgressPayload,
  type InstallerSource,
} from '@profer/shared'

/** 已注册的可取消下载：key -> cancel() */
const activeDownloads = new Map<string, () => void>()

/**
 * 构造安装包的本地缓存目录
 */
function getInstallerDir(): string {
  return path.join(app.getPath('temp'), 'profer-installers')
}

/**
 * 下载单个安装包：优先 downloadUrl，失败自动 fallback 到 fallbackUrl
 *
 * @param source 安装包元数据
 * @param key 去重键（前端可据此关联进度事件与取消）
 * @param sender 用于推进度事件的窗口（通常是发起下载的 BrowserWindow）
 */
export async function downloadInstaller(
  source: InstallerSource,
  key: string,
  sender?: BrowserWindow,
): Promise<InstallerDownloadResult> {
  const dir = getInstallerDir()
  await fsp.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, source.filename)

  // 尝试主 URL，失败再尝试 fallback
  const urls = [source.downloadUrl, source.fallbackUrl].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  if (urls.length === 0) {
    throw new Error('安装包清单缺少有效 URL')
  }

  let lastError: unknown = null
  for (const url of urls) {
    try {
      await downloadToFile(url, filePath, source, key, sender)
      const sha256 = await computeSha256(filePath)
      if (source.sha256 && sha256.toLowerCase() !== source.sha256.toLowerCase()) {
        await fsp.unlink(filePath).catch(() => {})
        throw new Error(
          `sha256 校验失败：期望 ${source.sha256}，实际 ${sha256}`,
        )
      }
      if (!source.sha256) {
        console.warn(
          `[Installer] ${source.filename} 清单未提供 sha256，跳过校验`,
        )
      }
      return { filePath, sha256 }
    } catch (error) {
      lastError = error
      const isCancelled =
        error instanceof Error && error.message === 'cancelled'
      if (isCancelled) {
        // 用户取消不降级到 fallback
        throw error
      }
      console.warn(
        `[Installer] 从 ${url} 下载失败，尝试下一个源：`,
        error,
      )
      await fsp.unlink(filePath).catch(() => {})
    }
  }

  throw (lastError as Error) ?? new Error('所有下载源均失败')
}

/**
 * 流式下载单个 URL 到指定文件，支持自动跟随 3xx 重定向
 */
function downloadToFile(
  url: string,
  filePath: string,
  source: InstallerSource,
  key: string,
  sender: BrowserWindow | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let cancelled = false
    let requestToAbort: { destroy: (err?: Error) => void } | null = null

    const cancel = () => {
      cancelled = true
      if (requestToAbort) {
        requestToAbort.destroy(new Error('cancelled'))
      }
    }
    activeDownloads.set(key, cancel)

    const cleanup = () => {
      activeDownloads.delete(key)
    }

    const fileStream = createWriteStream(filePath)

    const getModule = (u: URL) => (u.protocol === 'http:' ? httpGet : httpsGet)

    const doGet = (targetUrl: string, redirectsLeft: number) => {
      let parsed: URL
      try {
        parsed = new URL(targetUrl)
      } catch (e) {
        fileStream.close()
        cleanup()
        reject(e)
        return
      }

      const request = getModule(parsed)(targetUrl, (res: IncomingMessage) => {
        // 处理重定向
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()
          if (redirectsLeft <= 0) {
            fileStream.close()
            cleanup()
            reject(new Error('重定向次数过多'))
            return
          }
          const next = new URL(res.headers.location, parsed).toString()
          doGet(next, redirectsLeft - 1)
          return
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          fileStream.close()
          cleanup()
          reject(new Error(`HTTP ${res.statusCode ?? '?'}`))
          res.resume()
          return
        }

        const totalFromHeader = Number(res.headers['content-length'] ?? 0)
        const total = totalFromHeader > 0 ? totalFromHeader : source.sizeBytes
        let downloaded = 0
        let lastEmit = 0
        let lastEmitBytes = 0

        res.on('data', (chunk: Buffer) => {
          if (cancelled) return
          downloaded += chunk.length
          const now = Date.now()
          if (now - lastEmit >= 250 || downloaded === total) {
            const elapsed = (now - lastEmit) / 1000 || 1
            const speed = Math.round((downloaded - lastEmitBytes) / elapsed)
            lastEmit = now
            lastEmitBytes = downloaded
            emitProgress(sender, { key, downloaded, total, speed })
          }
        })

        res.pipe(fileStream)

        fileStream.on('finish', () => {
          fileStream.close()
          cleanup()
          if (cancelled) {
            reject(new Error('cancelled'))
          } else {
            // 最终再发一次 100% 进度
            emitProgress(sender, {
              key,
              downloaded: total,
              total,
              speed: 0,
            })
            resolve()
          }
        })

        fileStream.on('error', (err) => {
          fileStream.close()
          cleanup()
          reject(err)
        })

        res.on('error', (err) => {
          fileStream.close()
          cleanup()
          reject(err)
        })
      })

      requestToAbort = request

      request.on('error', (err: Error) => {
        fileStream.close()
        cleanup()
        reject(err)
      })
    }

    doGet(url, 5)
  })
}

function emitProgress(sender: BrowserWindow | undefined, payload: InstallerProgressPayload) {
  if (!sender || sender.isDestroyed()) return
  sender.webContents.send(INSTALLER_IPC_CHANNELS.PROGRESS, payload)
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const buf = await fsp.readFile(filePath)
  hash.update(buf)
  return hash.digest('hex')
}

/**
 * 取消正在进行的下载
 */
export function cancelInstallerDownload(key: string): boolean {
  const cancel = activeDownloads.get(key)
  if (cancel) {
    cancel()
    return true
  }
  return false
}

/**
 * 校验待拉起的安装包路径
 *
 * filePath 来自 renderer（经 INSTALLER_IPC_CHANNELS.LAUNCH 传入），不可信：
 * shell.openPath 能拉起任意可执行文件，必须限制在安装包缓存目录内。
 *
 * 校验方式：
 * 1. 必须是已存在的常规文件（拒绝目录、拒绝不存在）
 * 2. 解析符号链接后仍须落在 getInstallerDir() 之内
 * 3. 归属判断用 path.relative（Windows 下大小写不敏感），不用 startsWith 前缀比较
 *
 * @returns 通过校验的绝对路径（未解析符号链接的原路径，保持 openPath 语义不变）
 */
function resolveInstallerFile(filePath: string): string {
  if (!filePath || filePath.includes('\0')) {
    throw new Error('安装包路径无效：路径为空或包含非法字符')
  }

  const target = path.resolve(filePath)

  let stats
  try {
    stats = statSync(target)
  } catch {
    throw new Error(`安装包不存在：${target}`)
  }
  if (stats.isDirectory()) {
    throw new Error(`安装包路径指向目录，已拒绝启动：${target}`)
  }
  if (!stats.isFile()) {
    throw new Error(`安装包路径不是常规文件，已拒绝启动：${target}`)
  }

  // 符号链接会被 openPath 跟随，因此用 realpath 后的真实路径判断归属
  let realTarget: string
  let realDir: string
  try {
    realTarget = realpathSync(target)
    realDir = realpathSync(getInstallerDir())
  } catch {
    throw new Error(`安装包路径无法解析：${target}`)
  }

  const relative = path.relative(realDir, realTarget)
  const escapesDir =
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  if (escapesDir) {
    throw new Error(`安装包路径不在安装包缓存目录内，已拒绝启动：${target}`)
  }

  return target
}

/**
 * 拉起已下载的安装程序
 *
 * Windows 下 shell.openPath 会用系统默认方式打开 .exe / .msi，
 * 等同于用户双击，由操作系统决定是否弹 UAC。
 * 因此调用前必须先过 resolveInstallerFile 的目录白名单校验。
 */
export async function launchInstaller(filePath: string): Promise<void> {
  const target = resolveInstallerFile(filePath)
  const errorMsg = await shell.openPath(target)
  if (errorMsg) {
    throw new Error(`无法拉起安装程序：${errorMsg}`)
  }
}

/** 清理已下载的安装包缓存目录 */
export async function cleanInstallerDir(): Promise<number> {
  const dir = getInstallerDir()
  if (!existsSync(dir)) return 0
  let count = 0
  try {
    const files = await fsp.readdir(dir)
    for (const f of files) {
      try { await fsp.unlink(path.join(dir, f)); count++ } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count
}
