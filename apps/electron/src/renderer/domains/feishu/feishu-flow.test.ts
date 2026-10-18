import { expect, test } from 'bun:test'
import {
  buildBotSavePayload,
  buildNewBotPayload,
  canTestBot,
  defaultBotName,
  dropBinding,
  isRegistrationAbortError,
  nextSessionMirrorSettings,
  normalizeSessionMirrorSettings,
  qrExpireDelayMs,
  BOT_CONNECT_POLL_INTERVAL_MS,
  BOT_CONNECT_TIMEOUT_MS,
  QR_EXPIRED_MESSAGE,
  registrationErrorMessage,
  initialRegistrationState,
  registrationReducer,
  registrationRetryAction,
  replaceBinding,
  resolveBotToggleAction,
} from './feishu-flow'

test('新建 Bot 默认名按列表长度编号', () => {
  expect(defaultBotName(0)).toBe('飞书助手 1')
  expect(defaultBotName(2)).toBe('飞书助手 3')
})

test('手动添加的 Bot 载荷为未启用的空白配置', () => {
  expect(buildNewBotPayload(1)).toEqual({
    name: '飞书助手 2',
    enabled: false,
    appId: '',
    appSecret: '',
    defaultWorkspaceId: undefined,
    defaultChannelId: undefined,
    defaultModelId: undefined,
  })
})

test('扫码注册的 Bot 载荷携带凭据并启用', () => {
  const payload = buildNewBotPayload(0, { appId: 'cli_x', appSecret: 'secret-y' })
  expect(payload.enabled).toBe(true)
  expect(payload.appId).toBe('cli_x')
  expect(payload.appSecret).toBe('secret-y')
  expect(payload.name).toBe('飞书助手 1')
})

test('镜像设置归一化：仅 stream 保留 botId，其余视为关闭', () => {
  expect(normalizeSessionMirrorSettings({ mode: 'stream', botId: 'b1' })).toEqual({ mode: 'stream', botId: 'b1' })
  expect(normalizeSessionMirrorSettings({ mode: 'off', botId: 'b1' } as never)).toEqual({ mode: 'off' })
  expect(normalizeSessionMirrorSettings(undefined)).toEqual({ mode: 'off' })
})

test('切到 stream 时沿用已有 botId，否则回退到第一个启用的 Bot', () => {
  expect(nextSessionMirrorSettings('stream', 'kept', ['a', 'b'])).toEqual({ mode: 'stream', botId: 'kept' })
  expect(nextSessionMirrorSettings('stream', undefined, ['a', 'b'])).toEqual({ mode: 'stream', botId: 'a' })
  expect(nextSessionMirrorSettings('stream', undefined, [])).toEqual({ mode: 'stream', botId: undefined })
})

test('切回 off 时保留已有 botId', () => {
  expect(nextSessionMirrorSettings('off', 'kept', ['a'])).toEqual({ mode: 'off', botId: 'kept' })
})

test('扫码弹窗只过滤 abort 类错误', () => {
  expect(isRegistrationAbortError('The operation was aborted')).toBe(true)
  expect(isRegistrationAbortError('AbortError: x')).toBe(true)
  expect(isRegistrationAbortError('network down')).toBe(false)
})

test('二维码过期时长按秒换算，负值按 0 处理', () => {
  expect(qrExpireDelayMs(120)).toBe(120_000)
  expect(qrExpireDelayMs(-5)).toBe(0)
})

test('绑定更新只替换命中的 chatId，不改原数组', () => {
  const list = [{ chatId: 'c1', workspaceId: 'w1' }, { chatId: 'c2', workspaceId: 'w2' }]
  const next = replaceBinding(list, 'c2', { chatId: 'c2', workspaceId: 'w9' })
  expect(next).toEqual([{ chatId: 'c1', workspaceId: 'w1' }, { chatId: 'c2', workspaceId: 'w9' }])
  expect(list[1]?.workspaceId).toBe('w2')
  expect(replaceBinding(list, 'missing', { chatId: 'missing', workspaceId: 'x' })).toEqual(list)
})

test('解除绑定只移除命中的 chatId', () => {
  const list = [{ chatId: 'c1' }, { chatId: 'c2' }]
  expect(dropBinding(list, 'c1')).toEqual([{ chatId: 'c2' }])
  expect(dropBinding(list, 'missing')).toEqual(list)
})

test('Bot 保存载荷：名称与 appId 去空白，缺一则不保存', () => {
  const bot = { id: 'b1', defaultWorkspaceId: 'w', defaultChannelId: 'c', defaultModelId: 'm' }
  expect(buildBotSavePayload(bot, { name: '  助手  ', appId: ' cli_1 ', appSecret: '' })).toEqual({
    id: 'b1', name: '助手', enabled: true, appId: 'cli_1', appSecret: '',
    defaultWorkspaceId: 'w', defaultChannelId: 'c', defaultModelId: 'm',
  })
  expect(buildBotSavePayload(bot, { name: ' ', appId: 'cli_1', appSecret: 'x' })).toBeNull()
  expect(buildBotSavePayload(bot, { name: '助手', appId: '  ', appSecret: 'x' })).toBeNull()
})

test('连接测试需要 appId 与 Secret 均非空白', () => {
  expect(canTestBot(' cli_1 ', ' s ')).toBe(true)
  expect(canTestBot('cli_1', '  ')).toBe(false)
  expect(canTestBot('', 's')).toBe(false)
})

test('启停动作：已连接或连接中为 stop，否则 start', () => {
  expect(resolveBotToggleAction(true)).toBe('stop')
  expect(resolveBotToggleAction(false)).toBe('start')
})

test('Bot 连接轮询与超时常量保持既定值', () => {
  expect(BOT_CONNECT_POLL_INTERVAL_MS).toBe(1_000)
  expect(BOT_CONNECT_TIMEOUT_MS).toBe(60_000)
  expect(BOT_CONNECT_TIMEOUT_MS).toBeGreaterThan(BOT_CONNECT_POLL_INTERVAL_MS)
})

test('扫码重试：有凭据则重试保存，否则重新获取二维码', () => {
  expect(registrationRetryAction(true)).toBe('retry-save')
  expect(registrationRetryAction(false)).toBe('refetch-qrcode')
})

test('扫码注册阶段：正常流转 idle → qrcode → saving → success，不清空文案', () => {
  let state = initialRegistrationState
  state = registrationReducer(state, { type: 'qrcode' })
  expect(state).toEqual({ phase: 'qrcode', errorMsg: '' })
  state = registrationReducer(state, { type: 'saving' })
  state = registrationReducer(state, { type: 'success' })
  expect(state).toEqual({ phase: 'success', errorMsg: '' })
})

test('扫码注册阶段：error 携带文案，start 重置文案', () => {
  const failed = registrationReducer({ phase: 'saving', errorMsg: '' }, { type: 'error', message: '保存失败' })
  expect(failed).toEqual({ phase: 'error', errorMsg: '保存失败' })
  expect(registrationReducer(failed, { type: 'start' })).toEqual({ phase: 'idle', errorMsg: '' })
})

test('二维码过期文案保持不变', () => {
  expect(QR_EXPIRED_MESSAGE).toBe('二维码已过期，请重新获取。')
})

test('注册错误文案：Error 取 message，其余转字符串', () => {
  expect(registrationErrorMessage(new Error('boom'))).toBe('boom')
  expect(registrationErrorMessage('plain')).toBe('plain')
})
