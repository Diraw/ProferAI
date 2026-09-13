import { safeStorage } from 'electron'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { getInstalledPlugin } from './plugin-manager'
interface StoredCredential { declaration: string; encrypted: string }
function path(): string { return join(getConfigDir(), 'plugin-credentials.json') }
function credentialDeclaration(pluginId: string, id: string) {
  const declaration = getInstalledPlugin(pluginId)?.manifest.network?.credentials?.find((item) => item.id === id)
  if (!declaration) throw new Error('插件未声明此凭据')
  return declaration
}
/** 仅由主窗口设置界面调用，插件代码没有读取或设置凭据的接口。 */
export function setPluginCredential(pluginId: string, id: string, secret: string | null): void {
  const declaration = credentialDeclaration(pluginId, id)
  if (secret !== null && (!secret.trim() || secret.length > 8000 || /[\r\n]/.test(secret))) throw new Error('凭据格式非法')
  const all = readJsonFileSafe<Record<string, StoredCredential>>(path()) ?? {}
  const key = `${pluginId}:${id}`
  if (secret === null) delete all[key]
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，暂时无法保存凭据')
    all[key] = { declaration: JSON.stringify(declaration), encrypted: safeStorage.encryptString(secret).toString('base64') }
  }
  writeJsonFileAtomic(path(), all)
}
export function pluginCredentialHeader(pluginId: string, id: string, origin: string): Record<string, string> {
  const declaration = credentialDeclaration(pluginId, id)
  if (declaration.origin !== origin) throw new Error('凭据只能发送到绑定的服务')
  const stored = readJsonFileSafe<Record<string, StoredCredential>>(path())?.[`${pluginId}:${id}`]
  if (!stored || stored.declaration !== JSON.stringify(declaration)) throw new Error('请在插件设置中配置服务凭据')
  const secret = safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
  return { [declaration.header]: `${declaration.scheme === 'bearer' ? 'Bearer ' : ''}${secret}` }
}

export function removePluginCredentials(pluginId: string): void {
  const all = readJsonFileSafe<Record<string, StoredCredential>>(path()) ?? {}
  for (const key of Object.keys(all)) if (key.startsWith(`${pluginId}:`)) delete all[key]
  writeJsonFileAtomic(path(), all)
}
