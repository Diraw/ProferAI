/**
 * 安装包拉起（launchInstaller）路径白名单测试
 *
 * INSTALLER_IPC_CHANNELS.LAUNCH 的 filePath 由 renderer 传入，
 * 旧实现直接交给 shell.openPath，等价于给 renderer 一个「任意程序启动器」。
 * 这里验证：只有安装包缓存目录内的常规文件能被拉起。
 *
 * electron 的 app / shell 由 test/preload-electron-mock.ts 统一 mock，
 * --isolate 下测试文件无法二次 mock.module('electron')，因此用 spyOn 覆盖行为。
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { launchInstaller } from './installer-downloader'

// macOS 的 tmpdir 含 /var -> /private/var 符号链接，先取真实路径，避免归属判断被自身符号链接干扰
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'profer-installer-launch-')))
const installerDir = join(tempRoot, 'profer-installers')

let getPathSpy: { mockRestore: () => void } | undefined
const openPathSpies: Array<{ mockRestore: () => void }> = []

/** 覆盖 app.getPath('temp')，让 getInstallerDir() 指向测试临时目录 */
beforeAll(() => {
  mkdirSync(installerDir, { recursive: true })
  getPathSpy = spyOn(app, 'getPath').mockReturnValue(tempRoot)
})

afterEach(() => {
  while (openPathSpies.length > 0) openPathSpies.pop()?.mockRestore()
})

afterAll(() => {
  getPathSpy?.mockRestore()
  rmSync(tempRoot, { recursive: true, force: true })
})

/** 记录 shell.openPath 调用，并模拟成功（返回空字符串表示无错误） */
function spyOpenPath() {
  const spy = spyOn(shell, 'openPath').mockResolvedValue('')
  openPathSpies.push(spy)
  return spy
}

describe('launchInstaller：安装包目录白名单', () => {
  test('Given 目录内常规文件 When 拉起 Then 调用一次 openPath', async () => {
    const filePath = join(installerDir, 'Git-2.45.0-64-bit.exe')
    writeFileSync(filePath, 'installer')
    const openPath = spyOpenPath()

    await launchInstaller(filePath)

    expect(openPath).toHaveBeenCalledTimes(1)
    expect(openPath.mock.calls[0]?.[0]).toBe(filePath)
  })

  test('Given 目录外文件 When 拉起 Then 抛错且不调用 openPath', async () => {
    const outside = join(tempRoot, 'evil.sh')
    writeFileSync(outside, 'echo pwned')
    const openPath = spyOpenPath()

    await expect(launchInstaller(outside)).rejects.toThrow('安装包路径不在安装包缓存目录内')
    expect(openPath).not.toHaveBeenCalled()
  })

  test('Given 目录内符号链接指向目录外文件 When 拉起 Then 抛错且不调用 openPath', async () => {
    const outside = join(tempRoot, 'outside-target.sh')
    writeFileSync(outside, 'echo pwned')
    const linkPath = join(installerDir, 'link.exe')
    symlinkSync(outside, linkPath)
    const openPath = spyOpenPath()

    await expect(launchInstaller(linkPath)).rejects.toThrow('安装包路径不在安装包缓存目录内')
    expect(openPath).not.toHaveBeenCalled()
  })

  test('Given 传入目录本身 When 拉起 Then 抛错且不调用 openPath', async () => {
    const openPath = spyOpenPath()

    await expect(launchInstaller(installerDir)).rejects.toThrow('安装包路径指向目录')
    expect(openPath).not.toHaveBeenCalled()
  })

  test('Given 目录内不存在的文件 When 拉起 Then 抛错且不调用 openPath', async () => {
    const openPath = spyOpenPath()

    await expect(launchInstaller(join(installerDir, 'missing.exe'))).rejects.toThrow('安装包不存在')
    expect(openPath).not.toHaveBeenCalled()
  })

  test('Given 空路径 When 拉起 Then 抛错且不调用 openPath', async () => {
    const openPath = spyOpenPath()

    await expect(launchInstaller('')).rejects.toThrow('安装包路径无效')
    expect(openPath).not.toHaveBeenCalled()
  })
})
