import { expect, mock, test } from 'bun:test'
import { app } from 'electron'

/**
 * 回归测试：「版本获取无限转圈」的两个结构原因。
 *
 * 1. electron-updater 的请求没有超时，挂死后既不动也不报错；
 * 2. 挂死的请求会占住 in-flight 锁，让之后每次检查都合并进同一个永不结束的 Promise。
 *
 * 另外覆盖「检查不再等待下载」：以前 checkSource 里 await downloadUpdate()，
 * 一次 250MB 下载会让「检查更新」看起来一直在转。
 */

// 必须在导入模块前收紧预算：常量在模块求值时读取环境变量。
process.env.PROFER_UPDATE_CHECK_DEADLINE_MS = '5_000'
process.env.PROFER_UPDATE_CHECK_TOTAL_DEADLINE_MS = '200'
process.env.PROFER_UPDATE_INFLIGHT_STALE_MS = '300'

let checkImpl: () => Promise<unknown> = async () => ({ isUpdateAvailable: false })
const check = mock(() => checkImpl())
const download = mock(() => new Promise<never>(() => {}))
const setFeedURL = mock(() => undefined)
const handlers = new Map<string, (info: { version: string }) => void>()
const updater = {
  checkForUpdates: check,
  downloadUpdate: download,
  setFeedURL,
  on: (event: string, handler: (info: { version: string }) => void) => { handlers.set(event, handler) },
  autoDownload: true,
  autoInstallOnAppQuit: true,
}

mock.module('electron-updater', () => ({ autoUpdater: updater }))
mock.module('./update-probe', () => ({
  orderSourcesByReachability: async (sources: unknown[]) => sources,
  describeProbeOutcomes: () => '测试固定顺序',
}))
mock.module('../proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('../github-release-service', () => ({ getLatestRelease: async () => null }))

const { checkForUpdates, getUpdateStatus } = await import('./auto-updater')

// preload 已统一 mock electron，直接改同一个 app 对象，避免二次 mock 被 Bun 忽略。
Object.assign(app, { isPackaged: true, getVersion: () => '0.16.0' })

test('元数据请求挂死时按总预算收敛成超时错误，而不是永远转圈', async () => {
  checkImpl = () => new Promise(() => {})
  const startedAt = Date.now()

  await checkForUpdates()

  expect(Date.now() - startedAt).toBeLessThan(2_000)
  const status = getUpdateStatus()
  expect(status.status).toBe('error')
  expect(status.status === 'error' ? status.error : '').toContain('超时')
})

test('一次挂死不会毒化后续检查：下一次手动检查仍能正常完成', async () => {
  checkImpl = async () => ({ isUpdateAvailable: false })

  await checkForUpdates()

  expect(getUpdateStatus()).toEqual({ status: 'not-available' })
})

test('检查阶段不等待下载：下载永不结束时检查仍然立刻返回 downloading', async () => {
  checkImpl = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.16.1' } })
  const startedAt = Date.now()

  await checkForUpdates()

  expect(Date.now() - startedAt).toBeLessThan(1_000)
  expect(getUpdateStatus()).toMatchObject({ status: 'downloading', version: '0.16.1' })
  expect(download).toHaveBeenCalledTimes(1)
})
