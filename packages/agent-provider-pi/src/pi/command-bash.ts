import type { BashOperations } from '@earendil-works/pi-coding-agent'
import type { CommandExecutionPort, CommandExecutionRequest, CommandExecutionResult } from '@profer/agent-runtime'

export interface PiCommandBashOptions {
  commands: CommandExecutionPort
  /** 路径、shell 和运行环境由宿主解析；不在此读取文件或设置。 */
  prepare(command: string, cwd: string): Pick<CommandExecutionRequest, 'sessionId' | 'shell' | 'launcher' | 'runtimeEnv'>
  callbacks?(command: string, cwd: string): CommandExecutionRequest['callbacks']
  onResult?(result: CommandExecutionResult): void
}

/** Pi Bash SDK 契约与结构化执行端口之间的转换。进程/后台任务归属由宿主处理。 */
export function createPiCommandBashOperations(input: PiCommandBashOptions): BashOperations {
  return {
    async exec(command, cwd, options) {
      const callbacks = input.callbacks?.(command, cwd)
      const execution = await input.commands.execute({
        ...input.prepare(command, cwd),
        runtime: 'pi',
        command,
        cwd,
        env: options.env,
        timeoutMs: options.timeout !== undefined ? options.timeout * 1_000 : undefined,
        signal: options.signal,
        callbacks: {
          onSpawn: callbacks?.onSpawn,
          onStdout(data) { options.onData?.(data); callbacks?.onStdout?.(data) },
          onStderr(data) { options.onData?.(data); callbacks?.onStderr?.(data) },
        },
      })
      input.onResult?.(execution)
      if (execution.errorKind) {
        const message = execution.errorKind === 'shell_not_found'
          ? 'Bash 启动失败：shell_not_found（未找到可用的 Bash）'
          : execution.errorKind === 'working_directory_error'
            ? 'Bash 启动失败：working_directory_error（工作目录不可用）'
            : execution.stderr || `Bash 启动失败：${execution.errorKind}`
        throw Object.assign(new Error(message), { code: execution.errorCode })
      }
      if (execution.aborted) throw new Error('aborted')
      if (execution.timedOut) throw new Error(`timeout:${options.timeout}`)
      return { exitCode: execution.exitCode }
    },
  }
}
