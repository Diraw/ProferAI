/**
 * 飞书设置流程的纯逻辑：Bot 草稿、Session 镜像模式切换、扫码注册的判定。
 * 不依赖 React、Jotai 或页面组件；副作用与状态仍留在 FeishuSettings.tsx。
 */
import type { FeishuSessionMirrorSettings, FeishuSessionSyncMode } from '@profer/shared'
import type * as feishuApi from './feishu-api'

type SaveBotPayload = Parameters<typeof feishuApi.saveFeishuBotConfig>[0]

/** 新建 Bot 的默认名称，按当前列表长度编号 */
export function defaultBotName(index: number): string {
  return `飞书助手 ${index + 1}`
}

/**
 * 构造新建 Bot 的保存载荷。
 * 不传凭据时创建未启用的空白 Bot（手动添加）；传入扫码凭据时创建并启用（扫码注册）。
 */
export function buildNewBotPayload(index: number, credentials?: { appId: string; appSecret: string }): SaveBotPayload {
  return {
    name: defaultBotName(index),
    enabled: Boolean(credentials),
    appId: credentials?.appId ?? '',
    appSecret: credentials?.appSecret ?? '',
    defaultWorkspaceId: undefined,
    defaultChannelId: undefined,
    defaultModelId: undefined,
  }
}

/** 把宿主返回的镜像设置收敛为页面使用的形态，非 stream 模式一律视为关闭 */
export function normalizeSessionMirrorSettings(settings: FeishuSessionMirrorSettings | undefined): FeishuSessionMirrorSettings {
  return settings?.mode === 'stream'
    ? { mode: 'stream', botId: settings.botId }
    : { mode: 'off' }
}

/**
 * 计算切换同步模式后的镜像设置。
 * 切到 stream 且尚无 botId 时，回退到第一个已启用的 Bot；切回 off 保留已有 botId。
 */
export function nextSessionMirrorSettings(
  mode: FeishuSessionSyncMode,
  currentBotId: string | undefined,
  enabledBotIds: readonly string[],
): FeishuSessionMirrorSettings {
  if (mode === 'stream') return { mode, botId: currentBotId ?? enabledBotIds[0] }
  return { mode, botId: currentBotId }
}

/** 扫码注册时 SDK 在弹窗关闭后会抛出 abort 类错误，这类错误不应展示给用户 */
export function isRegistrationAbortError(message: string): boolean {
  return message.includes('aborted') || message.includes('Abort')
}

/**
 * Bot 卡片保存的载荷。名称或 appId 为空时返回 null，调用方不发起保存。
 * appSecret 为空时按空串传递，由宿主保留原凭据。
 */
export function buildBotSavePayload(
  bot: { id: string; defaultWorkspaceId?: string; defaultChannelId?: string; defaultModelId?: string },
  draft: { name: string; appId: string; appSecret: string },
): Parameters<typeof feishuApi.saveFeishuBotConfig>[0] | null {
  const name = draft.name.trim()
  const appId = draft.appId.trim()
  if (!name || !appId) return null
  return {
    id: bot.id,
    name,
    enabled: true,
    appId,
    appSecret: draft.appSecret || '',
    defaultWorkspaceId: bot.defaultWorkspaceId,
    defaultChannelId: bot.defaultChannelId,
    defaultModelId: bot.defaultModelId,
  }
}

/** 连接测试需要 appId 与 Secret 同时非空 */
export function canTestBot(appId: string, appSecret: string): boolean {
  return Boolean(appId.trim() && appSecret.trim())
}

/** 连接中或已连接时开关动作为停止，否则为启动 */
export function resolveBotToggleAction(isConnected: boolean): 'stop' | 'start' {
  return isConnected ? 'stop' : 'start'
}

/** 扫码注册弹窗的错误文案：Error 取 message，其余转字符串 */
export function registrationErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 绑定更新成功后，用宿主返回的新绑定替换列表中对应 chatId 的项；未命中则保持原列表 */
export function replaceBinding<T extends { chatId: string }>(list: readonly T[], chatId: string, next: T): T[] {
  return list.map((item) => (item.chatId === chatId ? next : item))
}

/** 解除绑定成功后，从列表中移除对应 chatId 的项 */
export function dropBinding<T extends { chatId: string }>(list: readonly T[], chatId: string): T[] {
  return list.filter((item) => item.chatId !== chatId)
}

/** Bot 连接中的状态轮询间隔（毫秒） */
export const BOT_CONNECT_POLL_INTERVAL_MS = 1_000

/** Bot 连接等待的最长时间（毫秒），超时后提示用户重试 */
export const BOT_CONNECT_TIMEOUT_MS = 60_000

/** 二维码过期后的提示文案 */
export const QR_EXPIRED_MESSAGE = '二维码已过期，请重新获取。'

/**
 * 扫码弹窗处于错误态时的重试动作：已有凭据则重试保存（凭据不丢失），否则重新获取二维码。
 */
export function registrationRetryAction(hasCredentials: boolean): 'retry-save' | 'refetch-qrcode' {
  return hasCredentials ? 'retry-save' : 'refetch-qrcode'
}

/** 扫码注册弹窗的阶段 */
export type RegistrationPhase = 'idle' | 'qrcode' | 'saving' | 'success' | 'error'

export interface RegistrationState {
  phase: RegistrationPhase
  errorMsg: string
}

/** 扫码注册弹窗的事件：start 为每次打开/重试时的重置 */
export type RegistrationEvent =
  | { type: 'start' }
  | { type: 'qrcode' }
  | { type: 'saving' }
  | { type: 'success' }
  | { type: 'error'; message: string }

export const initialRegistrationState: RegistrationState = { phase: 'idle', errorMsg: '' }

/**
 * 扫码注册的阶段流转。语义与改动前的分散 setPhase / setErrorMsg 保持一致：
 * qrcode / saving / success 不清空错误文案，只有 start 与 error 改写文案。
 */
export function registrationReducer(state: RegistrationState, event: RegistrationEvent): RegistrationState {
  switch (event.type) {
    case 'start': return { phase: 'idle', errorMsg: '' }
    case 'qrcode': return { ...state, phase: 'qrcode' }
    case 'saving': return { ...state, phase: 'saving' }
    case 'success': return { ...state, phase: 'success' }
    case 'error': return { phase: 'error', errorMsg: event.message }
  }
}

/** 二维码有效期（秒）转换为定时器毫秒数，负值按 0 处理 */
export function qrExpireDelayMs(expireInSeconds: number): number {
  return Math.max(0, expireInSeconds) * 1_000
}
