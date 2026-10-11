/** GitHub/商业版 Release 查询 IPC 注册。 */
import { ipcMain } from 'electron'
import { GITHUB_RELEASE_IPC_CHANNELS } from '@profer/shared'
import type { GitHubRelease, GitHubReleaseListOptions } from '@profer/shared'
import { getBuildTarget } from './build-target'
import { getLatestRelease, listReleases as listGitHubReleases, getReleaseByTag } from './github-release-service'

const RELEASES_JSON_URL = (process.env.PROFER_UPDATE_FEED_URL || 'https://updates.profer.cn/') + 'releases.json'

async function fetchServerReleases(): Promise<GitHubRelease[]> {
  const resp = await fetch(RELEASES_JSON_URL)
  if (!resp.ok) throw new Error(`服务器返回 ${resp.status}`)
  const data = await resp.json() as GitHubRelease[]
  if (!Array.isArray(data)) throw new Error('服务器返回数据格式错误')
  return data
}

export function registerGitHubReleaseIpc(): void {
  ipcMain.handle(GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE, async (): Promise<GitHubRelease | null> => {
    if (getBuildTarget() === 'commercial') {
      try { return (await fetchServerReleases())[0] ?? null } catch (err) { console.log('[版本历史] 服务器 releases 不可用:', err); return null }
    }
    return getLatestRelease()
  })
  ipcMain.handle(GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES, async (_, options?: GitHubReleaseListOptions): Promise<GitHubRelease[]> => {
    if (getBuildTarget() === 'commercial') {
      try { return (await fetchServerReleases()).slice(0, options?.perPage ?? 3) } catch (err) { console.log('[版本历史] 服务器 releases 不可用:', err); return [] }
    }
    return listGitHubReleases(options)
  })
  ipcMain.handle(GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG, async (_, tag: string): Promise<GitHubRelease | null> => {
    if (getBuildTarget() === 'commercial') {
      try { return (await fetchServerReleases()).find((release) => release.tag_name === tag) ?? null } catch (err) { console.log('[版本历史] 服务器 releases 不可用:', err); return null }
    }
    return getReleaseByTag(tag)
  })
}
