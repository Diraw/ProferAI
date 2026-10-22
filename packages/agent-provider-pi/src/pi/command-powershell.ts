import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BackgroundTaskPort, CommandExecutionPort, CommandExecutionResult, CommandRuntimeEnvironment, ProcessRegistrationPort } from '@profer/agent-runtime'

export interface PiPowerShellToolOptions {
  commands: CommandExecutionPort
  executable: string
  cwd: string
  sessionId?: string
  runtimeEnv?: CommandRuntimeEnvironment
  backgroundTasks?: BackgroundTaskPort
  processRegistration?: ProcessRegistrationPort
  maxTimeoutSeconds?: number
  defaultTimeoutSeconds?: number
}

function formatPowerShellResult(result: CommandExecutionResult): string {
  const suffix = result.timedOut
    ? '\nPowerShell 命令在超时后已终止。'
    : result.aborted
      ? '\nPowerShell 命令已中止。'
      : result.exitCode === 0
        ? ''
        : `\nPowerShell 以退出码 ${result.exitCode ?? 'unknown'} 结束。`
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(命令未产生输出)'
  return `${output}${suffix}`
}

/** 将 Pi PowerShell 工具转换为命令端口；Windows 组件解析与进程归属由宿主注入。 */
export function createPiPowerShellToolDefinition(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  options: PiPowerShellToolOptions,
): ToolDefinition {
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 600
  const defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? 30
  return sdk.defineTool({
    name: 'PowerShell',
    label: '执行 PowerShell',
    description: '在 Windows 原生 PowerShell 中执行命令。适用于 Windows 系统管理、进程、服务、注册表和 PowerShell 语法；跨平台命令继续使用 Bash。',
    promptSnippet: '在 Windows 上执行原生 PowerShell 命令。',
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: '要执行的 PowerShell 命令。' }),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTimeoutSeconds, description: `超时秒数，默认 ${defaultTimeoutSeconds}，最大 ${maxTimeoutSeconds}。` })),
    }),
    async execute(_toolCallId, params, signal) {
      const input = params as { command: string; timeout?: number }
      const registration = options.sessionId ? options.processRegistration?.registerPending({
        sessionId: options.sessionId,
        command: input.command,
        cwd: options.cwd,
        launcher: 'powershell',
      }) : undefined
      const taskId = registration?.id
      if (options.sessionId && taskId) options.backgroundTasks?.begin(options.sessionId, taskId, input.command)
      let result: CommandExecutionResult
      try {
        result = await options.commands.execute({
          sessionId: options.sessionId ?? '',
          runtime: 'pi',
          launcher: 'powershell',
          command: input.command,
          cwd: options.cwd,
          shell: options.executable,
          env: options.runtimeEnv?.env,
          timeoutMs: (input.timeout ?? defaultTimeoutSeconds) * 1_000,
          signal,
          runtimeEnv: options.runtimeEnv,
          callbacks: {
            onStdout: (data) => { if (options.sessionId && taskId) options.backgroundTasks?.append(options.sessionId, taskId, data) },
            onStderr: (data) => { if (options.sessionId && taskId) options.backgroundTasks?.append(options.sessionId, taskId, data) },
            onSpawn: (pid) => {
              if (!options.sessionId) return
              const shell = options.processRegistration?.registerShell({ sessionId: options.sessionId, command: input.command, cwd: options.cwd, launcher: 'powershell', pid })
              if (taskId && shell) options.backgroundTasks?.attachProcess(options.sessionId, taskId, pid, shell.startTime)
            },
          },
        })
      } catch (error) {
        if (options.sessionId && taskId) options.backgroundTasks?.complete(options.sessionId, taskId, 'failed')
        throw error
      }
      if (options.sessionId && taskId) {
        const status = result.aborted || result.timedOut ? 'stopped' : result.errorKind || result.exitCode !== 0 ? 'failed' : 'completed'
        options.backgroundTasks?.complete(options.sessionId, taskId, status)
      }
      return {
        content: [{ type: 'text', text: formatPowerShellResult(result) }],
        details: result,
      } as AgentToolResult<CommandExecutionResult>
    },
  }) as ToolDefinition
}

export { formatPowerShellResult }
