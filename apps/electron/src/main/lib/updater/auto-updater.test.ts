import { describe, expect, mock, test } from 'bun:test'
import type { GitHubRelease } from '@profer/shared'

// 禁止测试触发真实网络检查或下载；electron 由全局 preload 提供开发模式替身。
const check = mock(async () => null)
const download = mock(async () => [])
let latestRelease: GitHubRelease | null = null
const getLatestRelease = mock(async () => latestRelease)
mock.module('../github-release-service', () => ({ getLatestRelease }))
mock.module('electron-updater', () => ({
  autoUpdater: { checkForUpdates: check, downloadUpdate: download },
}))

const { checkForUpdates, getUpdateStatus } = await import('./auto-updater')

describe('开发版更新状态', () => {
  test('Given 未打包应用 When 获取初始状态 Then 保持 idle，允许手动检查最新 Release', () => {
    expect(getUpdateStatus()).toEqual({ status: 'idle' })
  })

  test('Given 开发版 When 手动或重复检查 Then 查询 Release 但不触发安装包下载', async () => {
    await checkForUpdates()
    await checkForUpdates()
    expect(getUpdateStatus()).toEqual({ status: 'not-available' })
    expect(check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(getLatestRelease).toHaveBeenCalledTimes(2)
  })

  test('Given 开发版发现新 Release Then 提供手动下载地址而不进入自动安装流程', async () => {
    latestRelease = {
      id: 1,
      tag_name: 'v99.0.0',
      name: 'Profer v99.0.0',
      body: '测试更新说明',
      draft: false,
      prerelease: false,
      created_at: '',
      published_at: '',
      html_url: 'https://github.com/Yuan-lai-ru-ci/Profer/releases/tag/v99.0.0',
    }

    await checkForUpdates()

    expect(getUpdateStatus()).toEqual({
      status: 'available',
      version: '99.0.0',
      releaseNotes: '测试更新说明',
      manualUrl: 'https://github.com/Yuan-lai-ru-ci/Profer/releases/tag/v99.0.0',
    })
    expect(check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })
})
