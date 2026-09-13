import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getConfigDir } from './config-paths'
import {
  isCredentialSensitivePath,
  isReadOnlyPreviewPathAllowed,
  isSystemSensitivePath,
  type PreviewPathPolicy,
} from './preview-path-policy'

/** 临时目录 fixture：模拟「皮肤目录 / 日志目录」这类会话工作区之外的路径。 */
function createFixtureFile(...segments: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-preview-policy-'))
  const file = join(root, ...segments)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'content')
  return file
}

describe('isReadOnlyPreviewPathAllowed', () => {
  test('会话工作区之外的普通文件放行（皮肤目录场景）', () => {
    const skinPreview = createFixtureFile('.profer-dev', 'skins', 'profer-lumen-mist-skin', 'preview.png')
    expect(isReadOnlyPreviewPathAllowed(skinPreview)).toBe(true)
  })

  test('临时日志文件放行（/tmp 日志场景）', () => {
    const logFile = createFixtureFile('logs', 'profer-dev-agent.log')
    expect(isReadOnlyPreviewPathAllowed(logFile)).toBe(true)
  })

  test('目录本身也放行（用于在文件管理器中定位）', () => {
    const skinDir = dirname(createFixtureFile('.profer-dev', 'skins', 'demo-skin', 'skin.css'))
    expect(isReadOnlyPreviewPathAllowed(skinDir)).toBe(true)
  })

  test('系统敏感位置拒绝', () => {
    expect(isReadOnlyPreviewPathAllowed('/etc/hosts')).toBe(false)
    expect(isSystemSensitivePath('/etc')).toBe(true)
  })

  test('凭据目录拒绝', () => {
    const secret = createFixtureFile('.ssh', 'id_ed25519')
    const policy: PreviewPathPolicy = { credentialSensitiveRoots: [join(dirname(secret), '..')] }
    expect(isReadOnlyPreviewPathAllowed(secret, policy)).toBe(false)
  })

  test('指向凭据目录的符号链接按真实路径拒绝', () => {
    const secret = createFixtureFile('.ssh', 'id_ed25519')
    const credentialRoot = dirname(secret)
    const linkDir = createFixtureFile('links', 'placeholder.txt')
    const link = join(dirname(linkDir), 'escape.png')
    symlinkSync(secret, link)
    const policy: PreviewPathPolicy = { credentialSensitiveRoots: [credentialRoot] }
    expect(isReadOnlyPreviewPathAllowed(link, policy)).toBe(false)
  })

  test('不存在的路径拒绝', () => {
    expect(isReadOnlyPreviewPathAllowed(join(tmpdir(), 'profer-preview-policy-missing', 'nope.md'))).toBe(false)
    expect(isReadOnlyPreviewPathAllowed('')).toBe(false)
  })
})

describe('isCredentialSensitivePath 默认边界', () => {
  test('覆盖私钥、钥匙串与 Profer 自身凭据', () => {
    expect(isCredentialSensitivePath(join(homedir(), '.ssh', 'id_ed25519'))).toBe(true)
    expect(isCredentialSensitivePath(join(homedir(), 'Library', 'Keychains', 'login.keychain-db'))).toBe(true)
    expect(isCredentialSensitivePath(join(getConfigDir(), 'auth-tokens.enc'))).toBe(true)
    expect(isCredentialSensitivePath(join(getConfigDir(), 'channels.json'))).toBe(true)
    expect(isCredentialSensitivePath(join(getConfigDir(), 'sdk-config', 'x.json'))).toBe(true)
  })

  test('不放宽到整个配置文件目录（皮肤目录仍可预览）', () => {
    expect(isCredentialSensitivePath(join(getConfigDir(), 'skins', 'demo-skin', 'skin.css'))).toBe(false)
  })
})
