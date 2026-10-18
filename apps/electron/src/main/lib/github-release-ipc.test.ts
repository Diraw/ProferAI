import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GITHUB_RELEASE_IPC_CHANNELS } from '@profer/shared'

const source = readFileSync(resolve(import.meta.dir, 'github-release-ipc.ts'), 'utf8')
const ipc = readFileSync(resolve(import.meta.dir, '..', 'ipc.ts'), 'utf8')

describe('GitHub Release IPC 注册（结构检查）', () => {
  test('新模块覆盖三个 Release 通道和商业版回源', () => {
    for (const key of ['GET_LATEST_RELEASE', 'LIST_RELEASES', 'GET_RELEASE_BY_TAG'] as const) {
      expect(source).toContain(`GITHUB_RELEASE_IPC_CHANNELS.${key}`)
      expect(GITHUB_RELEASE_IPC_CHANNELS[key]).toBeDefined()
    }
    expect(source).toContain('fetchServerReleases')
    expect(source).toContain("getBuildTarget() === 'commercial'")
  })
  test('注册入口与 ipc.ts 边界存在', () => {
    expect(source).toContain('export function registerGitHubReleaseIpc(): void')
    expect(ipc).toContain('registerGitHubReleaseIpc()')
    expect(ipc).not.toContain('GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE,')
  })
})
