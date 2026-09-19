import { describe, expect, test } from 'bun:test'
import { fanoutSessionEvent, type SessionEventFanout, type StreamSenderLike } from './agent-event-fanout'

/**
 * 回归测试：桌面端 resolved 事件不得重复投递。
 *
 * 模型说明：agent-service 的 EventBus IPC 中间件会把事件转发给该 session 已绑定的
 * webContents。因此本测试把 emitToBus 建模为「向 bound（未销毁时）投递一次」，
 * 再用实际发生的直发次数（sendToSender）判断是否产生了第二份。
 */

const SESSION_ID = 'session-1'

const PAYLOAD = {
  kind: 'profer_event',
  event: { type: 'permission_resolved', requestId: 'req-1', behavior: 'allow' },
}

interface FakeSender extends StreamSenderLike {
  readonly name: string
}

function sender(name: string, destroyed = false): FakeSender {
  return { name, isDestroyed: () => destroyed }
}

interface Delivery {
  channel: 'bus' | 'direct'
  target: string
  sessionId: string
  payload: unknown
}

function harness(bound: FakeSender | undefined | null) {
  const deliveries: Delivery[] = []
  const fanout: SessionEventFanout = {
    emitToBus: (sessionId, payload) => {
      // 中间件转发：仅当存在未销毁的绑定 webContents 时才真正送达
      deliveries.push({
        channel: 'bus',
        target: bound && !bound.isDestroyed() ? bound.name : 'none',
        sessionId,
        payload,
      })
    },
    getBoundSender: () => bound,
    sendToSender: (target, sessionId, payload) => {
      deliveries.push({ channel: 'direct', target: (target as FakeSender).name, sessionId, payload })
    },
  }

  const count = (channel: Delivery['channel']): number => deliveries.filter((d) => d.channel === channel).length
  const deliveredTo = (name: string): number => deliveries.filter((d) => d.target === name).length

  return { deliveries, fanout, count, deliveredTo }
}

describe('Agent 会话事件扇出（防止 resolved 事件重复投递）', () => {
  test('Given 发起方就是该 session 已绑定的 webContents When 扇出事件 Then 只投递一次且不兜底直发', () => {
    const main = sender('main-renderer')
    const h = harness(main)

    const result = fanoutSessionEvent(h.fanout, SESSION_ID, PAYLOAD, main)

    expect(result).toEqual({ deliveredToBus: true, fallbackSent: false })
    expect(h.count('direct')).toBe(0)
    // 总线中间件那一份就是全部：同一窗口只收到一次
    expect(h.deliveredTo(main.name)).toBe(1)
    expect(h.deliveries).toHaveLength(1)
  })

  test('Given 该 session 未绑定 webContents When 扇出事件 Then 兜底直发一次且载荷正确', () => {
    const h = harness(undefined)
    const main = sender('main-renderer')

    const result = fanoutSessionEvent(h.fanout, SESSION_ID, PAYLOAD, main)

    expect(result).toEqual({ deliveredToBus: true, fallbackSent: true })
    expect(h.count('bus')).toBe(1)
    expect(h.count('direct')).toBe(1)
    expect(h.deliveries.at(-1)).toEqual({
      channel: 'direct',
      target: main.name,
      sessionId: SESSION_ID,
      payload: PAYLOAD,
    })
    // 载荷原样透传（不做形状加工）
    expect(h.deliveries.at(-1)?.payload).toBe(PAYLOAD)
  })

  test('Given 过期 request 导致 sessionId 为空 When 扇出事件 Then 事件总线与兜底直发都不发生', () => {
    const main = sender('main-renderer')

    for (const expired of [undefined, null, ''] as const) {
      const h = harness(main)
      const result = fanoutSessionEvent(h.fanout, expired, PAYLOAD, main)

      expect(result).toEqual({ deliveredToBus: false, fallbackSent: false })
      expect(h.count('bus')).toBe(0)
      expect(h.count('direct')).toBe(0)
      expect(h.deliveries).toHaveLength(0)
    }
  })

  test('Given 绑定的 webContents 已销毁 When 扇出事件 Then 走兜底直发一次', () => {
    const h = harness(sender('main-renderer', true))
    const main = sender('main-renderer')

    const result = fanoutSessionEvent(h.fanout, SESSION_ID, PAYLOAD, main)

    expect(result).toEqual({ deliveredToBus: true, fallbackSent: true })
    expect(h.count('direct')).toBe(1)
    expect(h.deliveries).toHaveLength(2)
    expect(h.deliveredTo(main.name)).toBe(1)
  })

  test('Given 绑定的 webContents 不是发起方 When 扇出事件 Then 兜底直发一次且目标为发起方', () => {
    const otherWindow = sender('other-window')
    const h = harness(otherWindow)
    const main = sender('main-renderer')

    const result = fanoutSessionEvent(h.fanout, SESSION_ID, PAYLOAD, main)

    expect(result).toEqual({ deliveredToBus: true, fallbackSent: true })
    expect(h.count('direct')).toBe(1)
    expect(h.deliveries.at(-1)?.target).toBe(main.name)
  })

  test('Given 既无绑定也无发起方 When 扇出事件 Then 只进事件总线且不抛异常', () => {
    for (const fallback of [undefined, null] as const) {
      const h = harness(undefined)

      const result = fanoutSessionEvent(h.fanout, SESSION_ID, PAYLOAD, fallback)

      expect(result).toEqual({ deliveredToBus: true, fallbackSent: false })
      expect(h.count('bus')).toBe(1)
      expect(h.count('direct')).toBe(0)
    }
  })

  test('Given 发起方 webContents 已销毁且未绑定 When 扇出事件 Then 不尝试直发', () => {
    const h = harness(undefined)
    const main = sender('main-renderer', true)

    const result = fanoutSessionEvent(h.fanout, SESSION_ID, PAYLOAD, main)

    expect(result).toEqual({ deliveredToBus: true, fallbackSent: false })
    expect(h.count('direct')).toBe(0)
  })
})
