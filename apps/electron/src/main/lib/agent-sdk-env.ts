/**
 * agent-sdk-env — Claude Agent SDK 的完整环境构造（新旧两条链的**唯一**实现）。
 *
 * 背景：旧链（`AgentOrchestrator.buildSdkEnv`）会构造一份完整 SDK env：清理过的 `process.env`
 * 基线 + 输出 token 上限 + `PROFER_CLI` + Tasks / beta 开关 + 配置隔离目录 + 凭证 + 代理 +
 * Windows shell（Git Bash / WSL / `CLAUDE_BASH_NO_LOGIN`），并把未显式管理的 `ANTHROPIC_*` 置空，
 * 防止 shell 配置里的旧认证 / 旧端点经 `options.env` 叠加回流到 SDK 子进程。
 *
 * 新链（`runAgent` → runtime coordinator → Claude provider）最初只生成认证变量，于是 PATH、
 * 代理、`CLAUDE_CONFIG_DIR`、随包 CLI、Windows shell 全部丢失。本模块把这份 env 抽成同一实现，
 * 两条链共用，避免「同一份策略在两个入口下给出不同 SDK 环境」。
 *
 * 安全边界：
 * - 只写本次 query 的 env 副本，**绝不**回写 `process.env`；
 * - 所有注入源（代理 / shell 偏好 / runtime status / 随包 CLI / 配置目录）都以参数注入，
 *   便于用平台 fixture 在 macOS 上验证 Windows 语义。
 */

import type { ProviderType, RuntimeStatus } from '@profer/shared'
import { applySdkCredentials } from './agent-orchestrator-p0-guards'
import { getBundledCliPath, getSdkConfigDir } from './config-paths'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'

/** 本轮凭证（与 CredentialPort 解析结果同形，不引入第二套结构）。 */
export interface AgentSdkCredentialInput {
  apiKey: string
  baseUrl: string | undefined
  provider: ProviderType
  forceBearerAuth: boolean
}

export type AgentSdkShellPreference = 'auto' | 'git-bash' | 'wsl'

export interface BuildAgentSdkEnvOptions {
  /** 省略时读取生效代理设置（`getEffectiveProxyUrl()`）。 */
  proxyUrl?: string
  /** 省略时读取宿主 runtime status 单例。 */
  runtimeStatus?: RuntimeStatus | null
  /** 省略时读取用户设置 `agentShellPreference`。 */
  shellPreference?: AgentSdkShellPreference
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** 省略时使用随包 CLI 路径（开发模式为 undefined，与旧链同）。 */
  bundledCliPath?: string
  /** 省略时使用 SDK 隔离配置目录。 */
  sdkConfigDir?: string
}

/**
 * 构造完整 SDK env。
 *
 * 凭证只进入返回值，调用方不得写回 `process.env`；认证 / 端点变量由
 * `applySdkCredentials` 唯一写入（provider adapter 会再覆盖一次，结果一致）。
 */
export async function buildAgentSdkEnv(
  credentials: AgentSdkCredentialInput,
  options: BuildAgentSdkEnvOptions = {},
): Promise<Record<string, string | undefined>> {
  const { apiKey, baseUrl, provider, forceBearerAuth } = credentials
  const processEnv = options.processEnv ?? process.env
  const platform = options.platform ?? process.platform
  const bundledCliPath = options.bundledCliPath ?? getBundledCliPath()
  const sdkConfigDir = options.sdkConfigDir ?? getSdkConfigDir()

  // 从 process.env 继承系统变量，但清理所有 ANTHROPIC_ 前缀的变量，
  // 防止本地开发环境（如 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY、
  // ANTHROPIC_BASE_URL 等）干扰 SDK 的认证和请求目标。
  // 即使 index.ts 启动时已清理过一次，initializeRuntime() 中的
  // loadShellEnv() 可能从 shell 配置文件（~/.zshrc 等）重新注入这些变量。
  const cleanEnv: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(processEnv)) {
    if (!key.startsWith('ANTHROPIC_')) {
      cleanEnv[key] = value
    }
  }

  const sdkEnv: Record<string, string | undefined> = {
    ...cleanEnv,
    // 提升输出 token 上限，避免 "exceeded 32000 output token maximum" 错误
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    // 暴露打包进 App 的 profer CLI 路径，供 session-cleaner 等 skill / Agent 调用
    // （开发模式无编译二进制，getBundledCliPath 返回 undefined，此处不注入，
    //   skill 回退到源码运行 bun apps/cli/src/index.ts）。
    ...(bundledCliPath ? { PROFER_CLI: bundledCliPath } : {}),
    // 启用 Tasks 功能
    CLAUDE_CODE_ENABLE_TASKS: 'true',
    // 禁用实验性 beta 功能，使用稳定模式
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    // 配置隔离：让 SDK 使用独立的配置目录，不读取用户的 ~/.claude.json
    CLAUDE_CONFIG_DIR: sdkConfigDir,
  }

  // 凭证只写入本次 query 的 env，不回写主进程 process.env。
  applySdkCredentials(sdkEnv, apiKey, baseUrl, provider, forceBearerAuth)

  const proxyUrl = options.proxyUrl ?? await getEffectiveProxyUrl()
  if (proxyUrl) {
    sdkEnv.HTTPS_PROXY = proxyUrl
    sdkEnv.HTTP_PROXY = proxyUrl
  }

  // Windows 平台：配置 Shell 环境（支持用户偏好）
  if (platform === 'win32') {
    const runtimeStatus = options.runtimeStatus !== undefined ? options.runtimeStatus : getRuntimeStatus()
    const shellStatus = runtimeStatus?.shell
    const shellPreference = options.shellPreference ?? getSettings().agentShellPreference ?? 'auto'

    if (shellStatus) {
      let shellSet = false

      // 用户明确偏好 + 该 shell 可用 → 直接使用
      if (shellPreference === 'git-bash' && shellStatus.gitBash?.available && shellStatus.gitBash.path) {
        sdkEnv.CLAUDE_CODE_SHELL = shellStatus.gitBash.path
        console.log(`[Agent SDK env] 配置 Shell 环境: Git Bash（用户偏好）(${shellStatus.gitBash.path})`)
        shellSet = true
      } else if (shellPreference === 'wsl' && shellStatus.wsl?.available) {
        sdkEnv.CLAUDE_CODE_SHELL = 'wsl'
        console.log(`[Agent SDK env] 配置 Shell 环境: WSL（用户偏好）${shellStatus.wsl.version} (${shellStatus.wsl.defaultDistro})`)
        shellSet = true
      }

      // 自动模式或偏好 shell 不可用 → fallback
      if (!shellSet) {
        if (shellStatus.gitBash?.available && shellStatus.gitBash.path) {
          sdkEnv.CLAUDE_CODE_SHELL = shellStatus.gitBash.path
          console.log(`[Agent SDK env] 配置 Shell 环境: Git Bash (${shellStatus.gitBash.path})`)
        } else if (shellStatus.wsl?.available) {
          sdkEnv.CLAUDE_CODE_SHELL = 'wsl'
          console.log(`[Agent SDK env] 配置 Shell 环境: WSL ${shellStatus.wsl.version} (${shellStatus.wsl.defaultDistro})`)
        } else {
          console.warn('[Agent SDK env] Windows 平台未检测到可用的 Shell 环境（Git Bash / WSL）')
        }
      }
      sdkEnv.CLAUDE_BASH_NO_LOGIN = '1'
    }
  }

  // 针对 claude-agent-sdk 0.2.111+ 的 options.env 叠加语义加固：
  // SDK 将 options.env 叠加到 process.env 之上传递给子进程。
  // 若 shell 中存在 ANTHROPIC_CUSTOM_HEADERS、ANTHROPIC_MODEL 等变量，
  // 且 sdkEnv 未显式管理，叠加后会回流到 SDK 子进程。
  // 对于 sdkEnv 未显式管理的 ANTHROPIC_* 变量，显式置空字符串以覆盖回流。
  for (const key of Object.keys(processEnv)) {
    if (key.startsWith('ANTHROPIC_') && !(key in sdkEnv)) {
      sdkEnv[key] = ''
    }
  }

  return sdkEnv
}
