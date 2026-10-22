import type { SessionStore, SessionStorePaths } from '@profer/session-store'
import { createSessionStore, createSessionStorePaths } from '@profer/session-store'
import {
  getAgentSessionsDir,
  getAgentSessionsIndexPath,
  getAgentWorkspacesDir,
  getConfigDir,
  getPiCheckpointsDir,
  getSdkConfigDir,
} from './config-paths'

/**
 * Electron host 只负责把运行时路径注入 Node-only session-store。
 * 存储包本身不读取 Electron app.getPath，也不持有 provider SDK。
 */
export function createElectronSessionStorePaths(): SessionStorePaths {
  const sessionsDir = getAgentSessionsDir()
  return createSessionStorePaths(getConfigDir(), {
    sessionsIndex: getAgentSessionsIndexPath(),
    sessionsDir,
    graphDir: sessionsDir,
    harnessDir: sessionsDir,
    checkpointsDir: getPiCheckpointsDir(),
    sdkConfigDir: getSdkConfigDir(),
    workspaceRoot: getAgentWorkspacesDir(),
  })
}

export function createElectronSessionStore(): SessionStore {
  return createSessionStore(createElectronSessionStorePaths())
}
