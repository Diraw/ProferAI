import { ipcMain } from 'electron'
import { SKILL_MARKETPLACE_IPC_CHANNELS } from '@profer/shared'
import { readWorkspaceSkillContent, getWorkspaceSkills, scanSkillsInDir } from './agent-workspace-manager'
import { getAgentWorkspacePath } from './config-paths'
import { uploadFile, downloadFile, deleteRemoteFile, fetchFileManifest } from './team-file-service'
import { enqueueChange } from './sync-manager'
import { getTeamAuth } from './auth-service'
import { existsSync, mkdirSync, readFileSync, readFile, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetch as undiciFetch } from 'undici'

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)/)
    if (kv?.[1]) result[kv[1]] = (kv[2] ?? '').trim()
  }
  return result
}

async function readRemoteSkillMarkdown(workspaceId: string, slug: string): Promise<string | null> {
  const auth = getTeamAuth()
  if (!auth) return null
  const response = await (undiciFetch as unknown as typeof fetch)(`${auth.baseUrl}/v1/workspaces/${workspaceId}/files/download/${encodeURIComponent(`_skills/${slug}/SKILL.md`)}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  })
  if (!response.ok) return null
  return response.text()
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return 1
    if ((left[index] || 0) < (right[index] || 0)) return -1
  }
  return 0
}

export function registerSkillMarketplaceIpc(): void {
  ipcMain.handle(SKILL_MARKETPLACE_IPC_CHANNELS.PUBLISH, async (_, input: { workspaceId: string; workspaceSlug: string; skillSlug: string }) => {
    const skillDir = join(getAgentWorkspacePath(input.workspaceSlug), 'skills', input.skillSlug)
    if (!existsSync(skillDir)) throw new Error(`技能目录不存在: ${skillDir}`)
    const skillMdContent = readWorkspaceSkillContent(input.workspaceSlug, input.skillSlug)
    if (!skillMdContent) throw new Error('SKILL.md 不存在或为空')
    const uploadResult = await uploadFile(input.workspaceId, input.workspaceSlug, `_skills/${input.skillSlug}/SKILL.md`, Buffer.from(skillMdContent, 'utf-8'))
    if (!uploadResult.success) throw new Error(`上传失败: ${uploadResult.error}`)
    const uploadDir = async (dir: string, base: string): Promise<void> => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const relativePath = join(base, entry).replace(/\\/g, '/')
        if (entry === 'SKILL.md') continue
        if (statSync(full).isDirectory()) { await uploadDir(full, relativePath); continue }
        await uploadFile(input.workspaceId, input.workspaceSlug, `_skills/${input.skillSlug}/${relativePath}`, readFileSync(full))
      }
    }
    await uploadDir(skillDir, '')
    enqueueChange(input.workspaceId, 'skill', input.skillSlug, 'create', { workspaceId: input.workspaceId, skillSlug: input.skillSlug })
    return { success: true, skillSlug: input.skillSlug }
  })

  ipcMain.handle(SKILL_MARKETPLACE_IPC_CHANNELS.UNPUBLISH, async (_, input: { workspaceId: string; workspaceSlug: string; skillSlug: string }) => {
    const manifest = await fetchFileManifest(input.workspaceId, input.workspaceSlug)
    if (!manifest) throw new Error('无法获取文件清单')
    const prefix = `_skills/${input.skillSlug}/`
    for (const entry of manifest.filter((item) => item.path.startsWith(prefix))) await deleteRemoteFile(input.workspaceId, input.workspaceSlug, entry.path)
    enqueueChange(input.workspaceId, 'skill', input.skillSlug, 'delete', { workspaceId: input.workspaceId, skillSlug: input.skillSlug })
    return { success: true, skillSlug: input.skillSlug }
  })

  ipcMain.handle(SKILL_MARKETPLACE_IPC_CHANNELS.LIST_TEAM_SKILLS, async (_, workspaceId: string) => {
    const manifest = await fetchFileManifest(workspaceId)
    if (!manifest) return []
    const skillMap = new Map<string, { name: string; description: string; version: string; uploadedBy: string; modifiedAt: number }>()
    for (const entry of manifest) {
      if (!entry.path.startsWith('_skills/')) continue
      const slug = entry.path.slice(8).split('/')[0]
      if (!slug) continue
      if (!skillMap.has(slug)) skillMap.set(slug, { name: slug, description: '', version: '0.0.0', uploadedBy: '', modifiedAt: 0 })
      const skill = skillMap.get(slug)!
      if (entry.uploadedBy) skill.uploadedBy = entry.uploadedBy
      if (entry.modifiedAt > skill.modifiedAt) skill.modifiedAt = entry.modifiedAt
    }
    const result = []
    for (const [slug, skill] of skillMap) {
      if (!manifest.some((entry) => entry.path === `_skills/${slug}/SKILL.md`)) continue
      try {
        const content = await readRemoteSkillMarkdown(workspaceId, slug)
        if (content) {
          const frontmatter = parseFrontmatter(content)
          skill.name = frontmatter.name || slug
          skill.description = frontmatter.description || ''
          skill.version = frontmatter.version || '0.0.0'
        }
      } catch { /* 解析失败使用默认值 */ }
      result.push({ slug, name: skill.name, description: skill.description, version: skill.version, publishedBy: skill.uploadedBy, publishedAt: skill.modifiedAt })
    }
    return result
  })

  ipcMain.handle(SKILL_MARKETPLACE_IPC_CHANNELS.INSTALL_TEAM_SKILL, async (_, input: { workspaceId: string; skillSlug: string; targetWorkspaceSlug: string }) => {
    const manifest = await fetchFileManifest(input.workspaceId)
    if (!manifest) throw new Error('无法获取文件清单')
    const prefix = `_skills/${input.skillSlug}/`
    const skillFiles = manifest.filter((entry) => entry.path.startsWith(prefix))
    if (skillFiles.length === 0) throw new Error('技能不存在于市场中')
    const targetDir = join(getAgentWorkspacePath(input.targetWorkspaceSlug), 'skills', input.skillSlug)
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
    for (const entry of skillFiles) {
      const relativePath = entry.path.slice(prefix.length)
      const localPath = await downloadFile(input.workspaceId, input.targetWorkspaceSlug, entry.path, entry.uploadedBy, entry.sha256)
      if (!localPath) throw new Error(`下载失败: ${entry.path}`)
      const destination = join(targetDir, relativePath || 'SKILL.md')
      const destinationDir = join(destination, '..')
      if (!existsSync(destinationDir)) mkdirSync(destinationDir, { recursive: true })
      writeFileSync(destination, readFileSync(localPath))
    }
    try { scanSkillsInDir(targetDir, true) } catch { /* 重扫描静默 */ }
    return { success: true, skillSlug: input.skillSlug }
  })

  ipcMain.handle(SKILL_MARKETPLACE_IPC_CHANNELS.CHECK_FOR_UPDATES, async (_, workspaceSlug: string) => {
    const localSkills = getWorkspaceSkills(workspaceSlug) || []
    const updates = []
    for (const skill of localSkills) {
      if (!skill.sourceWorkspaceId) continue
      try {
        const manifest = await fetchFileManifest(skill.sourceWorkspaceId)
        if (!manifest || !manifest.some((entry) => entry.path === `_skills/${skill.slug}/SKILL.md`)) continue
        const content = await readRemoteSkillMarkdown(skill.sourceWorkspaceId, skill.slug)
        if (!content) continue
        const remoteVersion = parseFrontmatter(content).version || '0.0.0'
        if (compareVersions(remoteVersion, skill.version || '0.0.0') > 0) updates.push({ ...skill, latestVersion: remoteVersion })
      } catch { /* 网络错误跳过 */ }
    }
    return updates
  })
}
