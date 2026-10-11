/**
 * 应用图标资源路径解析。
 *
 * 独立于 IPC，供启动流程和应用图标 IPC 共同使用。
 */
import { app } from 'electron'
import { join } from 'node:path'

function getBundledResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
}

/** 解析应用图标变体的文件路径。 */
export function resolveAppIconPath(variantId: string): string | null {
  const resourcesDir = getBundledResourcesDir()
  if (!variantId || variantId === 'default') {
    return join(resourcesDir, 'icon.png')
  }
  return join(resourcesDir, 'profer-logos', `profer-${variantId}.png`)
}
