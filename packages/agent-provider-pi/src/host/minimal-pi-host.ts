/**
 * 非 Electron 最小 Pi 宿主（验证用）。
 *
 * 只提供 provider 真正需要的宿主事实替身：
 * - 结构化命令端口、后台任务端口、进程注册端口（内存实现，不 spawn 真实进程）；
 * - 内存权限端口（记录每次 canUseTool 调用，可脚本化 allow/deny）；
 * - 内存 session 存储与事件收集（可观察消息流，不写磁盘）；
 * - 测试工具装配入口（工具定义由调用方用真实 Pi SDK `defineTool` 构造）。
 *
 * 明确不包含：Browser / PPT / Image / 协作委派等产品能力，也不导入 apps/electron。
 */

import type {
  BackgroundTaskPort,
  CommandExecutionPort,
  CommandExecutionRequest,
  CommandExecutionResult,
  ProcessRegistrationPort,
} from '@profer/agent-runtime'
import type { SDKMessage } from '@profer/shared'
import type { PiAgentAdapterPorts } from '../ports'
import type { PiCanUseTool, PiPermissionResult } from '../permission'

/** 单条命令执行的记录；用于断言端口被真实调用过。 */
export interface MinimalCommandRecord {
  request: CommandExecutionRequest
  result: CommandExecutionResult
}

export interface MinimalProcessRecord {
  kind: 'pending' | 'shell'
  sessionId: string
  command: string
  cwd: string
}

export interface MinimalBackgroundRecord {
  kind: 'begin' | 'append' | 'attach' | 'complete' | 'stop'
  sessionId: string
  taskId: string
  detail?: string
}

/** 内存 session 存储：宿主负责持久化，provider 不碰磁盘。 */
export class MemorySessionStore {
  private readonly messages = new Map<string, SDKMessage[]>()
  private readonly meta = new Map<string, Record<string, unknown>>()

  appendMessages(sessionId: string, messages: readonly SDKMessage[]): void {
    const current = this.messages.get(sessionId) ?? []
    this.messages.set(sessionId, [...current, ...messages])
  }

  getMessages(sessionId: string): readonly SDKMessage[] {
    return this.messages.get(sessionId) ?? []
  }

  updateMeta(sessionId: string, patch: Record<string, unknown>): void {
    this.meta.set(sessionId, { ...(this.meta.get(sessionId) ?? {}), ...patch })
  }

  getMeta(sessionId: string): Record<string, unknown> | undefined {
    return this.meta.get(sessionId)
  }
}

export interface MinimalPermissionPolicy {
  /** 默认决策；未指定时按工具名判定。 */
  default?: PiPermissionResult['behavior']
  /** 需要显式拒绝的工具名。 */
  denyTools?: readonly string[]
  /** 注入到 updatedInput 的答案（模拟 AskUser 回答闭环）。 */
  answers?: Record<string, string>
}

export interface MinimalPiHost {
  ports: PiAgentAdapterPorts
  /** 权限端口：记录每次调用并返回脚本化决策。 */
  permissions: {
    canUseTool: PiCanUseTool
    calls: Array<{ toolName: string; input: Record<string, unknown> }>
  }
  /** 观察到的消息流（与 runtime 事件投影解耦，仅用于验证）。 */
  emitted: SDKMessage[]
  /** provider 交给宿主的消息（持久化替身）。 */
  sessions: MemorySessionStore
  commands: MinimalCommandRecord[]
  processes: MinimalProcessRecord[]
  background: MinimalBackgroundRecord[]
  /** 切换权限脚本；场景之间复用同一宿主时使用。 */
  setPermissionPolicy(next: MinimalPermissionPolicy): void
  reset(): void
}

export function createMinimalPiHost(): MinimalPiHost {
  const emitted: SDKMessage[] = []
  const sessions = new MemorySessionStore()
  const commands: MinimalCommandRecord[] = []
  const processes: MinimalProcessRecord[] = []
  const background: MinimalBackgroundRecord[] = []
  const calls: Array<{ toolName: string; input: Record<string, unknown> }> = []
  let policy: MinimalPermissionPolicy = {}

  const commandPort: CommandExecutionPort = {
    async execute(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
      request.callbacks?.onSpawn?.(4242)
      request.callbacks?.onStdout?.(Buffer.from(''))
      const result: CommandExecutionResult = {
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: 0,
        shell: request.shell,
        cwd: request.cwd,
        truncated: false,
      }
      commands.push({ request, result })
      return result
    },
    async cancel() {},
    get() {
      return undefined
    },
  }

  const backgroundTasks: BackgroundTaskPort = {
    begin(sessionId, taskId) {
      background.push({ kind: 'begin', sessionId, taskId })
    },
    append(sessionId, taskId, data) {
      background.push({ kind: 'append', sessionId, taskId, detail: typeof data === 'string' ? data : '<buffer>' })
    },
    attachProcess(sessionId, taskId) {
      background.push({ kind: 'attach', sessionId, taskId })
    },
    complete(sessionId, taskId, status) {
      background.push({ kind: 'complete', sessionId, taskId, detail: status })
    },
    async getOutput() {
      return { output: '', isComplete: true, status: 'completed' as const }
    },
    async stop(sessionId, taskId) {
      background.push({ kind: 'stop', sessionId, taskId })
    },
  }

  const processRegistration: ProcessRegistrationPort = {
    registerPending(input) {
      processes.push({ kind: 'pending', sessionId: input.sessionId, command: input.command, cwd: input.cwd })
      return { id: 'minimal-task', startTime: 1 }
    },
    registerShell(input) {
      processes.push({ kind: 'shell', sessionId: input.sessionId, command: input.command, cwd: input.cwd })
      return { id: 'minimal-task', startTime: 1 }
    },
  }

  const canUseTool: PiCanUseTool = async (toolName, input): Promise<PiPermissionResult> => {
    calls.push({ toolName, input })
    if (policy.denyTools?.includes(toolName)) {
      return { behavior: 'deny', message: `最小宿主拒绝工具 ${toolName}` }
    }
    if (policy.answers) {
      return { behavior: 'allow', updatedInput: { ...input, answers: policy.answers } }
    }
    return policy.default === 'deny'
      ? { behavior: 'deny', message: `最小宿主默认拒绝工具 ${toolName}` }
      : { behavior: 'allow' }
  }

  return {
    ports: {
      commands: commandPort,
      backgroundTasks,
      processRegistration,
    },
    permissions: { canUseTool, calls },
    emitted,
    sessions,
    commands,
    processes,
    background,
    setPermissionPolicy(next) {
      policy = next
    },
    reset() {
      emitted.length = 0
      commands.length = 0
      processes.length = 0
      background.length = 0
      calls.length = 0
      policy = {}
    },
  }
}
