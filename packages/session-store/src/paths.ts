import { join } from 'node:path'
import type { SessionStorePaths } from './contracts'

export function createSessionStorePaths(configDir: string, overrides: Partial<SessionStorePaths> = {}): SessionStorePaths {
  const sessionsDir = overrides.sessionsDir ?? join(configDir, 'agent-sessions')
  return {
    configDir,
    sessionsIndex: overrides.sessionsIndex ?? join(configDir, 'agent-sessions.json'),
    sessionsDir,
    blobsDir: overrides.blobsDir ?? join(configDir, 'blobs'),
    graphDir: overrides.graphDir ?? sessionsDir,
    harnessDir: overrides.harnessDir ?? sessionsDir,
    checkpointsDir: overrides.checkpointsDir ?? join(configDir, 'agent-checkpoints'),
    ...(overrides.sdkConfigDir ? { sdkConfigDir: overrides.sdkConfigDir } : {}),
    ...(overrides.workspaceRoot ? { workspaceRoot: overrides.workspaceRoot } : {}),
  }
}

export function sessionMessagesPath(paths: Pick<SessionStorePaths, 'sessionsDir'>, sessionId: string): string {
  return join(paths.sessionsDir, `${sessionId}.jsonl`)
}

export function sessionGraphPath(paths: SessionStorePaths, sessionId: string): string {
  return join(paths.graphDir, `${sessionId}-graph.jsonl`)
}

export function sessionHarnessPath(paths: SessionStorePaths, sessionId: string): string {
  return join(paths.harnessDir, `${sessionId}-pi-harness.jsonl`)
}
