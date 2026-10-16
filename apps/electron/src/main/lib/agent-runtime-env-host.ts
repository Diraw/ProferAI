/**
 * agent-runtime-env-host — 宿主侧 Pi runtimeEnv 的**唯一**解析实现（新旧两条链共用）。
 *
 * 背景：旧链（`AgentOrchestrator`）在每轮运行里手工拼 `buildAgentRuntimeEnv({...})`，
 * 新链（`runAgent` → runtime coordinator → Pi provider）默认只给 provider 传 cwd，
 * 于是 runtimeEnv 里的 shellPath / Git Bash / WSL / PATH / 代理全部丢失，
 * Windows 上 PI 的 Bash 工具会退回 `bash` 裸命令，macOS 上丢掉存在性校验过的 Bash 绝对路径。
 *
 * 本模块把「宿主才知道的事实」（runtime status、用户 shell 偏好、登录 shell 快照、代理）
 * 收敛成一处，平台判定只在这里发生一次，两条链都调用它。真正的 env 组装仍在
 * `agent-runtime-env.ts` 的 `buildAgentRuntimeEnv` 里（同一实现，避免第二套 PATH / 代理规则）。
 *
 * 边界：只读宿主状态与文件系统，不发事件、不写会话、不碰 Electron 窗口。
 */

import type { RuntimeStatus } from '@profer/shared'
import { buildAgentRuntimeEnv, mergeRuntimeEnv } from './agent-runtime-env'
import type { AgentRuntimeEnv } from './agent-runtime-env'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'
import { getOrCreateShellSnapshot } from './shell-snapshot'
import type { ShellDescriptor, ShellSnapshot } from './shell-snapshot'

/** 用户可选的 shell 偏好（与设置项 `agentShellPreference` 同域）。 */
export type AgentShellPreference = 'auto' | 'git-bash' | 'wsl'

export interface ResolveHostAgentRuntimeEnvOptions {
  sessionId: string
  /** 本轮 Agent 工作目录；登录 shell 快照按 (sessionId, cwd, shell) 复用。 */
  cwd: string
  platform?: NodeJS.Platform
  processEnv?: NodeJS.ProcessEnv
  /** 省略时读取用户设置（`getSettings().agentShellPreference`）。 */
  shellPreference?: AgentShellPreference
  /** 省略时读取宿主 runtime status 单例。 */
  runtimeStatus?: RuntimeStatus | null
  /** 省略时读取生效代理设置。 */
  proxyUrl?: string
  /** 省略时按 (sessionId, cwd, shell) 读取 / 创建登录 shell 快照。 */
  shellSnapshot?: ShellSnapshot
  pathExists?: (path: string) => boolean
  /** 省略时使用随包 CLI 路径（与 `buildAgentRuntimeEnv` 同一默认值）。 */
  bundledCliPath?: string
  /** 仅测试注入：宿主 ``delimiter`` 与平台不一致时使用。 */
  pathDelimiter?: string
}

/**
 * 由 runtime status + 用户偏好推导登录 shell 描述符。
 *
 * 与旧链逐字同源（`agent-orchestrator.ts` 里的 shell 选择）：
 * Windows 上遵守用户的 git-bash / wsl 偏好，否则按 runtime status 的推荐值探测；
 * 非 Windows 不指定 shell，交给 `inferShell` 按平台推断。
 */
export function resolveShellDescriptor(
  platform: NodeJS.Platform,
  shellPreference: AgentShellPreference,
  runtimeStatus: RuntimeStatus | null | undefined,
): ShellDescriptor | undefined {
  const gitBashPath = runtimeStatus?.shell?.gitBash.path
  if (platform === 'win32' && shellPreference === 'git-bash' && gitBashPath) {
    return { kind: 'git-bash', path: gitBashPath, login: false, source: 'configured' }
  }
  if (platform === 'win32' && shellPreference === 'wsl') {
    return { kind: 'wsl', path: 'wsl.exe', login: false, source: 'configured' }
  }
  if (runtimeStatus?.shell?.recommended === 'git-bash' && gitBashPath) {
    return { kind: 'git-bash', path: gitBashPath, login: false, source: 'detected' }
  }
  if (runtimeStatus?.shell?.recommended === 'wsl') {
    return { kind: 'wsl', path: 'wsl.exe', login: false, source: 'detected' }
  }
  return undefined
}

/**
 * 解析本轮的 Pi runtimeEnv（宿主状态 → 登录 shell 快照 → `buildAgentRuntimeEnv`）。
 *
 * 依赖注入点（`shellSnapshot` / `proxyUrl` / `runtimeStatus` / `shellPreference` / `platform`）
 * 让平台语义可以在任意宿主上用 fixture 验证（见 agent-runtime-env-host.test.ts）。
 */
export async function resolveHostAgentRuntimeEnv(
  options: ResolveHostAgentRuntimeEnvOptions,
): Promise<AgentRuntimeEnv> {
  const platform = options.platform ?? process.platform
  const processEnv = options.processEnv ?? process.env
  const shellPreference = options.shellPreference ?? getSettings().agentShellPreference ?? 'auto'
  const runtimeStatus = options.runtimeStatus !== undefined ? options.runtimeStatus : getRuntimeStatus()
  const shell = resolveShellDescriptor(platform, shellPreference, runtimeStatus)

  const shellSnapshot = options.shellSnapshot ?? await getOrCreateShellSnapshot({
    sessionId: options.sessionId,
    cwd: options.cwd,
    platform,
    processEnv,
    ...(runtimeStatus ? { source: 'runtime-status' as const } : {}),
    ...(shell ? { shell } : {}),
  })

  return buildAgentRuntimeEnv({
    proxyUrl: options.proxyUrl ?? await getEffectiveProxyUrl(),
    runtimeStatus,
    processEnv: shellSnapshot ? mergeRuntimeEnv(processEnv, shellSnapshot.env) : processEnv,
    shellPreference,
    platform,
    ...(options.bundledCliPath ? { bundledCliPath: options.bundledCliPath } : {}),
    ...(options.pathDelimiter ? { pathDelimiter: options.pathDelimiter } : {}),
    ...(options.pathExists ? { pathExists: options.pathExists } : {}),
  })
}
