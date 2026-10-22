import type {
  AgentRuntimePreparedContext,
  AgentRuntimeProviderQueryPreparationPort,
  AgentRuntimeQuery,
} from '@profer/agent-runtime'
import { homedir } from 'node:os'
import type { ProferPermissionMode } from '@profer/shared'
import { buildAgentSdkEnv } from './agent-sdk-env'
import { resolveHostAgentRuntimeEnv } from './agent-runtime-env-host'
import { resolveSDKCliPath } from './agent-sdk-cli-path'
import { getSdkConfigDir } from './config-paths'
import { resolveProviderPermissionMode, stripAgentRuntimePolicyFromProviderInput } from './agent-runtime-policy-snapshot'

function promptFromPrepared(input: AgentRuntimeQuery, prepared: AgentRuntimePreparedContext): string | { type: 'preset'; preset: 'claude_code'; append?: string } {
  return prepared.systemPrompt ?? prepared.resources?.systemPrompt ?? input.prompt
}

/**
 * 交给 provider 的权限模式。
 *
 * 只认两处来源：宿主挂载的有效策略快照（已收敛预设上限与合法覆盖），或调用方显式给出的
 * 合法覆盖。两者都没有时返回 undefined —— 这里刻意不再回落 `auto`：
 * 猜一个默认值会让「同一份策略」在不同入口下给出不同工具放行口径，属于 G4 的根因。
 * 策略快照的挂载责任在宿主入口（见 agent-runtime-policy-snapshot.ts 的接线说明）。
 */
function permissionModeFromInput(input: AgentRuntimeQuery): ProferPermissionMode | undefined {
  return resolveProviderPermissionMode(input.providerInput)
}

/**
 * 新链 provider preparation 的宿主环境解析依赖。
 *
 * `resolveRuntimeEnv` 可注入：测试用 fixture 直接验证「新链把 runtimeEnv 传给 Pi provider」
 * 而不真的去启动登录 shell 采快照；生产不传时用同一条宿主实现。
 */
export interface ElectronProviderQueryPreparationOptions {
  resolveRuntimeEnv?: typeof resolveHostAgentRuntimeEnv
}

/** Electron 组合根的最小 provider-specific query builder；预设策略经 providerInput 传入，本函数不重新解释。 */
export function createElectronProviderQueryPreparation(
  options: ElectronProviderQueryPreparationOptions = {},
): AgentRuntimeProviderQueryPreparationPort {
  const resolveRuntimeEnv = options.resolveRuntimeEnv ?? resolveHostAgentRuntimeEnv
  return {
    async prepare(input, prepared, signal) {
      signal.throwIfAborted()
      const credentials = prepared.credentials
      if (!credentials) throw new Error('Provider query preparation requires resolved credentials')
      const permissionMode = permissionModeFromInput(input)
      const systemPrompt = promptFromPrepared(input, prepared)
      // 快照不进 provider options：provider 只应看到 permissionMode 这类自己能理解的字段。
      const providerInput = stripAgentRuntimePolicyFromProviderInput(input.providerInput)
      if (input.runtime === 'claude') {
        // 与旧链同源：完整 SDK env（PATH / 代理 / CLAUDE_CONFIG_DIR / 随包 CLI /
        // Windows Git Bash|WSL / CLAUDE_BASH_NO_LOGIN / ANTHROPIC_* 回流加固），
        // 不再只生成认证变量。凭证只进入本次 query 的 env 副本。
        const env = await buildAgentSdkEnv(credentials)
        return {
          ...providerInput,
          sdkCliPath: resolveSDKCliPath(),
          env,
          ...(permissionMode
            ? {
                sdkPermissionMode: permissionMode,
                allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
              }
            : {}),
          systemPrompt,
          cwd: input.cwd,
          ...(prepared.tools !== undefined ? { tools: [...prepared.tools] } : {}),
          ...(prepared.mcpServers !== undefined ? { mcpServers: prepared.mcpServers } : {}),

          ...(prepared.plugins !== undefined ? { plugins: [...prepared.plugins] } : {}),
          ...(prepared.skills !== undefined ? { skills: [...prepared.skills] } : {}),
          ...(prepared.allowedTools !== undefined ? { allowedTools: [...prepared.allowedTools] } : {}),
          ...(prepared.disallowedTools !== undefined ? { disallowedTools: [...prepared.disallowedTools] } : {}),
          ...(prepared.canUseTool ? { canUseTool: prepared.canUseTool } : {}),
          ...(input.runtimeSessionId ? { resumeSessionId: input.runtimeSessionId } : {}),
          ...(input.providerInput?.resumeSessionAt ? { resumeSessionAt: input.providerInput.resumeSessionAt } : {}),
          ...(input.additionalDirectories ? { additionalDirectories: [...input.additionalDirectories] } : {}),
        }
      }

      // Pi runtimeEnv 与旧链同源（宿主状态 / 登录 shell 快照 / 平台判定只有一份实现）：
      // 缺它时 Windows 丢失 Git Bash|WSL 选择、macOS/Linux 丢失经过存在性校验的 Bash 绝对路径。
      const runtimeEnv = await resolveRuntimeEnv({
        sessionId: input.sessionId,
        // 无 cwd 时与旧链一样用用户主目录（绝不用 process.cwd()：桌面启动目录不可预测）。
        cwd: input.cwd ?? homedir(),
      })
      return {
        ...providerInput,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        provider: credentials.provider,
        codexOAuthCredentials: credentials.codexOAuthCredentials,
        xaiOAuthCredentials: credentials.xaiOAuthCredentials,
        xaiCredentialMode: credentials.xaiCredentialMode,
        xaiApiProtocol: credentials.xaiApiProtocol,
        ...(permissionMode ? { permissionMode } : {}),
        systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : systemPrompt.append ?? input.prompt,
        ...(prepared.tools !== undefined ? { customTools: [...prepared.tools] } : {}),
        ...(prepared.mcpServers !== undefined ? { mcpServers: prepared.mcpServers } : {}),

        ...(prepared.plugins !== undefined ? { plugins: [...prepared.plugins] } : {}),
        ...(prepared.skills !== undefined ? { skills: [...prepared.skills] } : {}),
        ...(prepared.allowedTools !== undefined ? { allowedTools: [...prepared.allowedTools] } : {}),
        ...(prepared.disallowedTools !== undefined ? { disallowedTools: [...prepared.disallowedTools] } : {}),
        ...(prepared.canUseTool ? { canUseTool: prepared.canUseTool } : {}),
        piAgentDir: getSdkConfigDir(),
        piSessionDir: `${getSdkConfigDir()}/sessions/pi`,
        runtimeEnv,
        cwd: input.cwd,
        ...(input.runtimeSessionId ? { resumeSessionId: input.runtimeSessionId } : {}),
        ...(input.providerInput?.resumeSessionAt ? { resumeSessionAt: input.providerInput.resumeSessionAt } : {}),
        ...(input.additionalDirectories ? { additionalDirectories: [...input.additionalDirectories] } : {}),
      }
    },
  }
}
