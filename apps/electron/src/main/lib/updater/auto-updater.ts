/**
 * 自动更新核心模块
 *
 * 打包版：检测新版本 → 自动后台下载 → 用户确认后重启安装。
 * 开发版：只检查最新 Release，并引导手动下载，不尝试覆盖源码目录。
 */

import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { runWithUpdateSourceFallback } from './update-fallback'
import { orderSourcesByReachability, describeProbeOutcomes } from './update-probe'
import { getUpdateSources, UPDATE_PROBE_TIMEOUT_MS, type UpdateSource } from './update-sources'
import { canReplaceUpdateStatus } from './update-state'
import { withDeadline, UpdateTimeoutError } from './update-deadline'
import { getLatestRelease } from '../github-release-service'

const GITHUB_RELEASES_URL = 'https://github.com/Yuan-lai-ru-ci/ProferAI/releases'

/** 允许用环境变量收紧/放宽时间预算，便于现场排障与测试；非法值回落默认。 */
function timingFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 单个更新源的元数据检查上限。
 *
 * electron-updater 自己没有请求超时（见 update-deadline.ts 的说明），所以每个源都必须
 * 由我们强制截断：超时即视为该源不可用，换下一个源，而不是继续等。
 */
export const UPDATE_CHECK_DEADLINE_MS = timingFromEnv('PROFER_UPDATE_CHECK_DEADLINE_MS', 12_000)
/** 整轮检查（探活 + 多源回退）的总预算。到点必须给出终态，不允许继续转圈。 */
export const UPDATE_CHECK_TOTAL_DEADLINE_MS = timingFromEnv('PROFER_UPDATE_CHECK_TOTAL_DEADLINE_MS', 25_000)
/** 下载停滞判定：连续这么久没有任何进度事件，就认为连接已经死了。 */
export const UPDATE_DOWNLOAD_STALL_MS = timingFromEnv('PROFER_UPDATE_DOWNLOAD_STALL_MS', 45_000)
/** 僵尸检查：in-flight 超过这个时长仍未结束，说明它已挂死，允许新的检查接管。 */
export const UPDATE_INFLIGHT_STALE_MS = timingFromEnv('PROFER_UPDATE_INFLIGHT_STALE_MS', 60_000)

/** 当前更新状态 */
// 开发版也支持检查最新 Release；只有“自动下载安装”能力在开发版不可用。
let currentStatus: UpdateStatus = { status: 'idle' }

/** 主窗口引用 */
let win: BrowserWindow | null = null

/** 定时检查定时器 */
let checkInterval: ReturnType<typeof setInterval> | null = null

/** 同一时间只允许一个检查/下载流程，防止手动与定时检查互相覆盖状态。 */
let inFlightUpdateCheck: Promise<void> | null = null
let inFlightStartedAt = 0

/**
 * 轮次编号：每轮检查自增。`abandonedRound` 记录被超时判死的那一轮，
 * 事件处理器据此丢弃挂起请求的迟到事件——否则一个 30s 后才回来的
 * `update-not-available` 会把刚给用户的「检查超时」覆盖成「已是最新」。
 */
let currentRound = 0
// -1 表示「还没有任何轮次被判死」；用 0 会和初始 currentRound 相等，导致首轮之前的事件全被当成迟到。
let abandonedRound = -1

/** 下载看门狗：attempt 每次下载自增，用来作废旧尝试的迟到回调。 */
let downloadAttempt = 0
/** 当前下载的 promise，停滞时用它比对 electron-updater 的内部缓存。 */
let inFlightDownload: Promise<unknown> | null = null
/** 当前正在等元数据的 checkForUpdates() promise，总预算判死时用它清掉内部缓存。 */
let inFlightCheck: Promise<unknown> | null = null
let lastDownloadProgressAt = 0
let downloadWatchdog: ReturnType<typeof setInterval> | null = null

/** 更新状态并推送给渲染进程 */
function setStatus(status: UpdateStatus): void {
  if (!canReplaceUpdateStatus(currentStatus, status)) {
    console.log(`[更新] 保留已下载状态，忽略迟到的 ${status.status} 事件`)
    return
  }
  currentStatus = status
  win?.webContents?.send(UPDATER_IPC_CHANNELS.ON_STATUS_CHANGED, status)
}

/** 获取当前更新状态 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 当前轮次是否已被判死；判死后要忽略底层请求的迟到事件。 */
function lateEventIgnored(event: string): boolean {
  if (abandonedRound !== currentRound) return false
  console.log(`[更新] 忽略已放弃轮次的迟到事件: ${event}`)
  return true
}

function stopDownloadWatchdog(): void {
  if (downloadWatchdog) {
    clearInterval(downloadWatchdog)
    downloadWatchdog = null
  }
}

/**
 * 下载看门狗：electron-updater 的下载同样没有超时，连接僵死后 download-progress
 * 会彻底静默。这里用「多久没有新进度」判定停滞，把状态收敛成可重试的错误，
 * 而不是让进度条永远停在某个百分比。
 */
function startDownloadWatchdog(attempt: number): void {
  stopDownloadWatchdog()
  downloadWatchdog = setInterval(() => {
    if (attempt !== downloadAttempt) {
      stopDownloadWatchdog()
      return
    }
    const idleMs = Date.now() - lastDownloadProgressAt
    if (idleMs < UPDATE_DOWNLOAD_STALL_MS) return
    downloadAttempt += 1
    stopDownloadWatchdog()
    // 下载同样会在 electron-updater 内部缓存 promise，不清掉的话重试只会拿到同一个死 promise。
    if (inFlightDownload) {
      releaseStuckUpdaterPromise('downloadPromise', inFlightDownload)
      inFlightDownload = null
    }
    console.warn(`[更新] 下载停滞 ${Math.round(idleMs / 1000)}s，放弃本次下载`)
    setStatus({
      status: 'error',
      error: `下载停滞超过 ${Math.round(UPDATE_DOWNLOAD_STALL_MS / 1000)}s，请检查网络后重试`,
    })
  }, 5_000)
  ;(downloadWatchdog as unknown as { unref?: () => void }).unref?.()
}

/**
 * 检查阶段结束后在后台下载。
 *
 * 以前 `checkSource` 里是 `await downloadUpdate()`，于是「检查更新」这个 IPC 要等
 * 整个安装包下载完才返回，界面上按钮就一直在转。现在检查一有结论就返回，
 * 下载进度完全由状态事件驱动。
 */
function startBackgroundDownload(version: string): void {
  if (currentStatus.status === 'downloading' || currentStatus.status === 'downloaded') {
    console.log('[更新] 已在下载中或已下载完成，跳过重复下载')
    return
  }
  const attempt = ++downloadAttempt
  lastDownloadProgressAt = Date.now()
  setStatus({
    status: 'downloading',
    version,
    progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
  })
  startDownloadWatchdog(attempt)
  const pendingDownload = autoUpdater.downloadUpdate()
  inFlightDownload = pendingDownload
  void pendingDownload.then(() => {
    if (inFlightDownload === pendingDownload) inFlightDownload = null
  }).catch((error) => {
    if (inFlightDownload === pendingDownload) inFlightDownload = null
    if (attempt !== downloadAttempt) return
    stopDownloadWatchdog()
    console.error('[更新] 下载更新失败:', error)
    setStatus({ status: 'error', error: `下载更新失败：${errorMessage(error)}` })
  })
}

/**
 * 丢掉 electron-updater 内部缓存的挂死 promise。
 *
 * `checkForUpdates()` / `downloadUpdate()` 都会把进行中的 promise 缓存在实例字段
 * `checkForUpdatesPromise` / `downloadPromise` 上，**只在 resolve/reject 时清空**。
 * 我们的截止时间只是「不再等」，底层请求仍然挂起，于是缓存永久指向同一个死 promise：
 * 之后每次检查/下载都直接复用它，界面就从「无限转圈」变成「每次检查都超时」，
 * 用户只能重启应用。放弃一轮时必须把仍是同一个 promise 的缓存清掉，下一次才会真正
 * 重新发起请求。只在身份一致时清空，避免误清后来者。
 */
function releaseStuckUpdaterPromise(
  field: 'checkForUpdatesPromise' | 'downloadPromise',
  pending: unknown,
): void {
  const internals = autoUpdater as unknown as Record<string, unknown>
  if (internals[field] !== pending) return
  internals[field] = null
  console.warn(`[更新] 已清理挂死的 ${field}，下一次操作会重新发起请求`)
}

/**
 * 在单一更新源上执行「检查」阶段。
 *
 * 下载不再在这里 await：检查有结论就返回，下载交给 startBackgroundDownload。
 * 每个源的元数据请求都用 withDeadline 强制截断，避免一个挂死的源吃掉整轮检查。
 */
async function checkSource(source: UpdateSource, round: number): Promise<boolean> {
  autoUpdater.setFeedURL(source.configuration)
  console.log(`[更新] 尝试更新源: ${source.label}`)

  const pendingCheck = autoUpdater.checkForUpdates()
  inFlightCheck = pendingCheck
  let result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  try {
    result = await withDeadline(
      pendingCheck,
      UPDATE_CHECK_DEADLINE_MS,
      `检查${source.label}元数据`,
    )
  } catch (error) {
    // 超时意味着这个请求不会再回来：清掉 electron-updater 的缓存，否则下一轮只会复用它。
    if (error instanceof UpdateTimeoutError) releaseStuckUpdaterPromise('checkForUpdatesPromise', pendingCheck)
    throw error
  } finally {
    if (inFlightCheck === pendingCheck) inFlightCheck = null
  }

  // 本轮已被总预算判死，或底层请求晚到：结果作废。
  if (round !== currentRound || round === abandonedRound) return false
  if (!result?.isUpdateAvailable) {
    return false
  }

  const candidateVersion = result.updateInfo?.version ?? result.versionInfo?.version
  if (candidateVersion && isBlockedInternalUpdate(candidateVersion)) {
    console.log(`[更新] 内测包 ${getCurrentAppVersion()} 忽略同/更低正式基线 ${candidateVersion}`)
    setStatus({ status: 'not-available' })
    return false
  }

  startBackgroundDownload(candidateVersion ?? '')
  return true
}

export function compareVersions(left: string, right: string): number {
  // 内测包采用 `正式版本-internal.x`，更新判断只比较正式基线三段数字：
  // 0.15.85-internal.4 与 0.15.85 应视为同一正式基线，不能把同基线正式包当更新。
  const parseBaseVersion = (value: string): number[] => (value.replace(/^v/, '').split('-', 1)[0] ?? '').split('.').map((part) => {
    const parsed = Number(part)
    return Number.isFinite(parsed) ? parsed : 0
  })
  const leftParts = parseBaseVersion(left)
  const rightParts = parseBaseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const INTERNAL_VERSION_PATTERN = /^v?\d+\.\d+\.\d+-internal\.\d+$/i

/** 只有明确的内测版本才启用“正式基线”保护，正式版行为保持 electron-updater 原样。 */
export function isInternalVersion(version: string): boolean {
  return INTERNAL_VERSION_PATTERN.test(version.trim())
}

/**
 * electron-updater 使用 semver 比较时，会把同基线正式版视为高于 internal 版。
 * 对当前内测包，仅拒绝同/更低的正式基线；更高正式版本和内测序号升级仍不拦截。
 */
export function shouldBlockInternalBaseline(currentVersion: string, candidateVersion: string): boolean {
  return isInternalVersion(currentVersion)
    && /^v?\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(candidateVersion)
    && compareVersions(candidateVersion, currentVersion) <= 0
}

function getCurrentAppVersion(): string {
  return app.getVersion()
}

function isBlockedInternalUpdate(candidateVersion: string): boolean {
  return shouldBlockInternalBaseline(getCurrentAppVersion(), candidateVersion)
}

async function checkDevelopmentUpdate(): Promise<void> {
  setStatus({ status: 'checking' })
  const release = await getLatestRelease()
  // getLatestRelease 只在请求失败时返回 null。必须与「确实没有新版本」区分，
  // 否则断网 / 代理不通 / 触发 GitHub Rate limit 时开发者会看到“已是最新版本”的假象。
  if (!release) {
    setStatus({ status: 'error', error: '无法获取最新版本信息，请检查网络或代理设置' })
    return
  }
  if (release.draft || release.prerelease) {
    setStatus({ status: 'not-available' })
    return
  }
  const version = release.tag_name.replace(/^v/, '')
  if (compareVersions(version, app.getVersion()) <= 0) {
    setStatus({ status: 'not-available' })
    return
  }
  setStatus({
    status: 'available',
    version,
    releaseNotes: release.body || undefined,
    manualUrl: release.html_url || GITHUB_RELEASES_URL,
  })
}

/**
 * 探活单个更新源的元数据地址。
 *
 * 只判断「有没有拿到 HTTP 响应」：拿到任何状态码都算可达——4xx（例如 mac 通道历史上
 * 长期 404）在真实检查时会快速失败，代价远小于黑洞 IP 吃满 30s 超时，因此不需要在
 * 这里提前判定内容有效性。只捕获网络层异常（DNS 失败、连接超时、TLS 错误）。
 */
async function probeSourceReachable(source: UpdateSource): Promise<boolean> {
  if (!source.probeUrl) return false
  try {
    const response = await fetch(source.probeUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(UPDATE_PROBE_TIMEOUT_MS),
    })
    return response.status > 0
  } catch {
    return false
  }
}

async function runUpdateCheck(): Promise<void> {
  const round = ++currentRound
  abandonedRound = -1
  setStatus({ status: 'checking' })

  try {
    // 先并发探活再决定顺序：串行回退遇到黑洞 IP 时，每次检查都会先白等满一次超时。
    const declaredSources = getUpdateSources()
    const sources = await orderSourcesByReachability(declaredSources, probeSourceReachable)
    console.log(`[更新] 源可达性探测：${describeProbeOutcomes(declaredSources, sources)}`)

    // 总预算：多个源各自超时叠加起来仍可能让用户等上几分钟，必须在整轮上再封一道顶。
    const foundUpdate = await withDeadline(
      runWithUpdateSourceFallback(
        sources,
        (source) => checkSource(source, round),
        (source, error) => {
          console.warn(`[更新] ${source.label} 不可用，切换备用源:`, errorMessage(error))
        },
        // 总预算已经判死本轮时，剩余源不再发请求：否则一个已经超时的检查还会继续占用连接。
        () => round !== currentRound || round === abandonedRound,
      ),
      UPDATE_CHECK_TOTAL_DEADLINE_MS,
      '检查更新',
    )
    if (!foundUpdate) {
      console.log('[更新] 当前已是最新版本')
      // 不能把「离开 checking」寄托在 electron-updater 的 update-not-available 事件上：
      // 事件可能因源实现差异或迟到而不来，状态机就会停在 checking。
      if (round === currentRound && round !== abandonedRound) {
        setStatus({ status: 'not-available' })
      }
    }
  } catch (error) {
    abandonedRound = round
    if (error instanceof UpdateTimeoutError) {
      // 整轮被总预算判死时，挂死的是最后那个还在等元数据的源；它的 promise 会永久留在
      // electron-updater 的缓存里，必须在这里一并清掉，否则下一轮检查只会复用它。
      if (inFlightCheck) {
        releaseStuckUpdaterPromise('checkForUpdatesPromise', inFlightCheck)
        inFlightCheck = null
      }
      console.error('[更新] 检查更新超时，已停止等待:', error.message)
      setStatus({ status: 'error', error: `${error.message}，请检查网络或代理后重试` })
      return
    }
    const message = errorMessage(error)
    console.error('[更新] 所有更新源均不可用:', message)
    setStatus({ status: 'error', error: message })
  }
}

/**
 * 登记 in-flight 任务。
 *
 * 只在「当前登记的仍是这个任务」时清理，避免一个挂死旧任务的 finally 把新任务清掉。
 */
function trackInFlight(task: Promise<void>): Promise<void> {
  inFlightUpdateCheck = task
  inFlightStartedAt = Date.now()
  void task.finally(() => {
    if (inFlightUpdateCheck === task) {
      inFlightUpdateCheck = null
      inFlightStartedAt = 0
    }
  }).catch(() => {})
  return task
}

/**
 * 是否存在仍应复用的 in-flight 任务。
 *
 * 这是「一次挂死永久毒化后续检查」的兜底：即使某次请求绕过了所有超时，
 * 超过 UPDATE_INFLIGHT_STALE_MS 后也允许新的检查接管，而不是无限期合并。
 */
function hasLiveInFlight(): boolean {
  if (!inFlightUpdateCheck) return false
  const ageMs = Date.now() - inFlightStartedAt
  if (ageMs < UPDATE_INFLIGHT_STALE_MS) return true
  console.warn(`[更新] 上一次检查已挂起 ${Math.round(ageMs / 1000)}s，放弃它并重新开始`)
  inFlightUpdateCheck = null
  inFlightStartedAt = 0
  return false
}

/** 手动触发检查更新 */
export async function checkForUpdates(): Promise<void> {
  // 开发版不能把安装包覆盖到源码目录，但可以检查最新 Release，方便开发期间及时获知
  // 新版本；真正安装仍由用户打开发布页下载正式安装包完成。
  if (!app.isPackaged) {
    console.log('[更新] 开发模式，检查 GitHub 最新 Release')
    if (hasLiveInFlight()) return inFlightUpdateCheck!
    return trackInFlight(
      checkDevelopmentUpdate().catch((error) => {
        const message = errorMessage(error)
        console.error('[更新] 开发版检查更新失败:', message)
        setStatus({ status: 'error', error: message })
      }),
    )
  }

  // 已在下载中或已下载完成，不重复检查
  if (currentStatus.status === 'downloading' || currentStatus.status === 'downloaded') {
    console.log('[更新] 跳过检查：已在下载中或已下载完成')
    return
  }

  if (hasLiveInFlight()) {
    console.log('[更新] 合并重复检查请求')
    return inFlightUpdateCheck!
  }

  return trackInFlight(runUpdateCheck())
}

/** 退出并安装已下载的更新 */
export function quitAndInstall(): void {
  // 移除所有窗口的 close 监听器，避免 preventDefault 阻止退出
  for (const w of BrowserWindow.getAllWindows()) {
    w.removeAllListeners('close')
  }

  // 延迟调用确保 IPC 响应已发送回渲染进程
  setImmediate(() => {
    autoUpdater.quitAndInstall(true, true)
  })
}

/** 清理更新器资源（定时器等） */
export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  stopDownloadWatchdog()
}

/**
 * 装配 electron-updater（仅在打包版可用：feed URL 在打包时嵌入）。
 *
 * 开发版不装配任何会尝试安装的路径，调度与状态推送由 initAutoUpdater 统一负责。
 */
function setupPackagedAutoUpdater(): void {
  // 应用代理设置 — electron-updater 底层用 Electron net 模块，遵循 HTTPS_PROXY 环境变量
  try {
    const { getEffectiveProxyUrl } = require('../proxy-settings-service') as {
      getEffectiveProxyUrl: () => Promise<string | undefined>
    }
    getEffectiveProxyUrl().then((proxyUrl: string | undefined) => {
      if (proxyUrl) {
        process.env.HTTPS_PROXY = proxyUrl
        process.env.HTTP_PROXY = proxyUrl
        console.log('[更新] 已应用代理:', proxyUrl)
      }
    }).catch(() => {})
  } catch { /* 代理模块不可用时跳过 */ }

  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log('[更新-updater]', ...args),
    warn: (...args: unknown[]) => console.warn('[更新-updater]', ...args),
    error: (...args: unknown[]) => console.error('[更新-updater]', ...args),
    debug: (...args: unknown[]) => console.log('[更新-updater:debug]', ...args),
  }

  // 由 checkSource 显式下载，才能在下载失败后切换另一个更新源。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // 监听更新事件
  autoUpdater.on('checking-for-update', () => {
    if (lateEventIgnored('checking-for-update')) return
    console.log('[更新] 正在检查更新...')
    setStatus({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    if (lateEventIgnored('update-available')) return
    if (isBlockedInternalUpdate(info.version)) {
      console.log(`[更新] 内测包 ${getCurrentAppVersion()} 忽略同/更低正式基线 ${info.version}`)
      setStatus({ status: 'not-available' })
      return
    }
    console.log('[更新] 发现新版本:', info.version)
    setStatus({
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    lastDownloadProgressAt = Date.now()
    if (lateEventIgnored('download-progress')) return
    const version = (currentStatus as { version?: string }).version || ''
    // 被拒绝的 available 事件不会留下版本；忽略其迟到的进度，避免出现空版本下载状态。
    if (isInternalVersion(getCurrentAppVersion()) && !version) return
    if (version && isBlockedInternalUpdate(version)) {
      console.log(`[更新] 内测包拒绝同/更低正式基线下载进度 ${version}`)
      setStatus({ status: 'not-available' })
      return
    }
    setStatus({
      status: 'downloading',
      version,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    stopDownloadWatchdog()
    if (lateEventIgnored('update-downloaded')) return
    if (isBlockedInternalUpdate(info.version)) {
      console.log(`[更新] 内测包拒绝同/更低正式基线下载完成 ${info.version}`)
      setStatus({ status: 'not-available' })
      return
    }
    console.log('[更新] 下载完成:', info.version)
    setStatus({
      status: 'downloaded',
      version: info.version,
    })
  })

  autoUpdater.on('update-not-available', () => {
    if (lateEventIgnored('update-not-available')) return
    console.log('[更新] 已是最新版本')
    setStatus({ status: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    if (lateEventIgnored('error')) return
    console.error('[更新] 更新出错:', err)
    // 当前检查流程会捕获此错误并切换备用源。只有脱离该流程的异常才直接展示。
    if (!inFlightUpdateCheck) setStatus({ status: 'error', error: err.message })
  })
}

/**
 * 初始化自动更新
 *
 * @param mainWindow - 主窗口实例，用于推送更新状态
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow

  // 开发版不能把安装包覆盖到源码目录，feed URL 也只在打包后嵌入，因此不装配
  // electron-updater；但下面的调度照旧执行，走 checkDevelopmentUpdate 检查最新
  // Release 并引导手动下载（否则开发期间完全感知不到新版本）。
  if (app.isPackaged) {
    setupPackagedAutoUpdater()
  } else {
    console.log('[更新] 开发模式：跳过自动安装装配，仅检查最新 Release')
  }

  // 启动后延迟 10 秒首次检查
  setTimeout(() => {
    console.log('[更新] 首次自动检查更新')
    checkForUpdates()
  }, 10_000)

  // 每 4 小时自动检查一次
  checkInterval = setInterval(() => {
    console.log('[更新] 定时自动检查更新')
    checkForUpdates()
  }, 4 * 60 * 60 * 1000)

  // 窗口关闭时清理定时器
  mainWindow.on('closed', () => {
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
    win = null
  })

  console.log(
    app.isPackaged
      ? '[更新] 自动更新模块已初始化（国内主源、GitHub 备用，自动下载）'
      : '[更新] 开发版更新检查已初始化（仅检查最新 Release，提示手动下载）',
  )
}
