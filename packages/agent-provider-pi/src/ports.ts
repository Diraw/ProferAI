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

/** 历史图片降级参数；由 provider 决定层级，宿主只负责按参数转码。 */
export interface PiImageTranscodeOptions {
  /** 输出图片最长边（像素）。 */
  maxSide: number
  /** JPEG 质量，0-100。 */
  quality: number
  /** 输出 base64 字符串长度上限；宿主应尽量压到该值以内。 */
  maxBase64Bytes: number
}

export interface PiImageTranscodeInput {
  data: string
  mimeType: string
}

export interface PiImageTranscodeResult {
  data: string
  mimeType: string
}

/**
 * 历史图片转码端口。
 *
 * provider 不直接依赖 Electron/nativeImage；宿主注入该端口后，旧图可以在请求前
 * 降采样/转 JPEG，而不是被直接删除。端口缺失时 provider 退化为仅按张数/字节省略。
 */
export interface PiImageTranscoderPort {
  transcode(input: PiImageTranscodeInput, options: PiImageTranscodeOptions): Promise<PiImageTranscodeResult | null>
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
  /** 历史图片压缩；缺省时只做张数/字节裁剪，不做降采样。 */
  imageTranscoder?: PiImageTranscoderPort
}
