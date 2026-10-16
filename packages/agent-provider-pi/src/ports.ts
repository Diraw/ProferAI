/**
 * Pi provider 的宿主注入依赖。
 *
 * 这些是 provider 无法自行决定的宿主事实（官方托管渠道判定、xAI OAuth 凭据落盘），
 * 通过最小注入接口传入，避免 provider 直接或间接导入 apps/electron。
 * 缺口以外的通用执行能力仍走 runtime 现有端口（command / background task /
 * process registration / permission / resource / deferred tool assembly）。
 */

import type { PiModelRegistryHost } from './pi/model-registry'
import type { BackgroundTaskPort, CommandExecutionPort, ProcessRegistrationPort } from '@profer/agent-runtime'

/** 宿主事实注入；未提供时退化为无外部副作用的默认行为（与 runtime 原默认值一致）。 */
export interface PiProviderHostDependencies {
  /** 渠道账号策略：官方托管渠道判定、xAI OAuth 凭据记忆与串行刷新。 */
  modelRegistry?: PiModelRegistryHost
}

/** Pi adapter 的可注入端口集合；宿主实现与测试替身使用同一形状。 */
export interface PiAgentAdapterPorts {
  /** 结构化命令执行端口；缺省时 Bash/PowerShell 工具回落到内置进程执行。 */
  commands?: CommandExecutionPort
  /** 后台任务端口；TaskOutput / TaskStop 与 shell 后台任务依赖它。 */
  backgroundTasks?: BackgroundTaskPort
  /** 进程注册端口；用于把 agent 拉起的子进程登记到宿主进程表。 */
  processRegistration?: ProcessRegistrationPort
  /** 宿主事实注入。 */
  host?: PiProviderHostDependencies
}
