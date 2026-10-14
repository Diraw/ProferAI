import { afterEach, describe, expect, test } from 'bun:test'
import {
  createRechargeOrder, createRechargeStatusReader, createSubscriptionPurchase,
  createSubscriptionStatusReader, openCreditsPaymentPage, redeemCredits,
  requestRechargeConfig, requestSubscriptionPricing,
} from './credits-api'

const originalFetch = globalThis.fetch
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

function installFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}

function installHost(authenticated = true, openExternal: (url: string) => Promise<void> = async () => {}): { authCalls: number } {
  const calls = { authCalls: 0 }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: {
      auth: { getTeamAuth: async () => {
        calls.authCalls++
        return authenticated ? { baseUrl: 'https://profer.example', token: 'fixture-token' } : null
      } },
      openExternal,
    } },
  })
  return calls
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

for (const [label, path, readConfig] of [
  ['充值', '/v1/account/credits/recharge-config', requestRechargeConfig],
  ['定价', '/v1/account/config/plans', requestSubscriptionPricing],
] as const) {
  describe(`${label}配置`, () => {
    test('沿用服务端返回值与认证', async () => {
      installHost()
      const fixture = { adminWechat: 'fixture-admin' }
      installFetch(async (url, init) => {
        expect(String(url)).toBe(`https://profer.example${path}`)
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token')
        return Response.json(fixture)
      })
      expect(await readConfig()).toMatchObject(fixture)
    })
    for (const failure of ['unauthenticated', 'http', 'network', 'json'] as const) {
      test(`${failure} 返回 null，允许页面使用默认值`, async () => {
        installHost(failure !== 'unauthenticated')
        let calls = 0
        installFetch(async () => {
          calls++
          if (failure === 'network') throw new Error('断网')
          return new Response('invalid', { status: failure === 'http' ? 500 : 200 })
        })
        expect(await readConfig()).toBeNull()
        expect(calls).toBe(failure === 'unauthenticated' ? 0 : 1)
      })
    }
  })
}

const purchaseInput = { product: 'subscription', plan: 'plus', cycle: 'monthly', payType: 'wxpay' } as const
const mutations = [
  ['兑换', '/v1/account/redeem', () => redeemCredits('code'), { code: 'code' }, { description: '已兑换' }],
  ['充值', '/v1/account/credits/recharge', () => createRechargeOrder(1000, 'alipay'), { amountRmb: 1000, payType: 'alipay' }, { orderId: 'order', payInfo: { method: 'online' } }],
  ['订阅', '/v1/account/subscription/purchase', () => createSubscriptionPurchase(purchaseInput), purchaseInput, { orderId: 'order', payInfo: { method: 'online' } }],
] as const

for (const [label, path, mutate, body, data] of mutations) {
  describe(`${label}写请求`, () => {
    test('只发起一次 POST，字段与单位不变', async () => {
      installHost()
      let calls = 0
      installFetch(async (url, init) => {
        calls++
        expect(String(url)).toBe(`https://profer.example${path}`)
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token')
        expect(JSON.parse(String(init?.body))).toEqual(body)
        return Response.json(data)
      })
      const result: unknown = await mutate()
      expect(result).toEqual({ kind: 'success', data })
      expect(calls).toBe(1)
    })
    test('未登录不发送 POST', async () => {
      installHost(false)
      let calls = 0
      installFetch(async () => { calls++; throw new Error('不应发请求') })
      expect(await mutate()).toEqual({ kind: 'unauthenticated' })
      expect(calls).toBe(0)
    })
    test('保留业务拒绝文案', async () => {
      installHost()
      installFetch(async () => Response.json({ error: '业务拒绝' }, { status: 400 }))
      expect(await mutate()).toEqual({ kind: 'failed', message: '业务拒绝' })
    })
    test('非 JSON 的 HTTP 错误返回失败', async () => {
      installHost()
      installFetch(async () => new Response('bad gateway', { status: 502 }))
      expect(await mutate()).toEqual({ kind: 'failed' })
    })
    for (const invalid of ['invalid-json', 'null', 'array', 'network'] as const) {
      test(`${invalid} 不会误报成功或未登录`, async () => {
        installHost()
        installFetch(async () => {
          if (invalid === 'network') throw new Error('断网')
          if (invalid === 'invalid-json') return new Response('invalid')
          return Response.json(invalid === 'null' ? null : [])
        })
        await expect(mutate()).rejects.toThrow()
      })
    }
  })
}

for (const [label, mutate] of [
  ['充值', () => createRechargeOrder(1000, 'wxpay')],
  ['订阅', () => createSubscriptionPurchase(purchaseInput)],
] as const) {
  describe(`${label}订单响应`, () => {
    for (const orderId of [undefined, '', ' ', 123]) {
      test(`拒绝无效在线订单号 ${String(orderId)}`, async () => {
        installHost()
        installFetch(async () => Response.json({ orderId, payInfo: { method: 'online' } }))
        expect(await mutate()).toEqual({ kind: 'failed' })
      })
    }
    test('手动收款信息可正常返回', async () => {
      installHost()
      const data = { orderId: 'manual-order', payInfo: { method: 'manual', adminWechat: 'admin' } }
      installFetch(async () => Response.json(data))
      expect(await mutate()).toEqual({ kind: 'success', data })
    })
  })
}

for (const [label, path, createReader] of [
  ['充值', '/v1/account/credits/recharge/status', createRechargeStatusReader],
  ['订阅', '/v1/account/subscription/purchase/status', createSubscriptionStatusReader],
] as const) {
  describe(`${label}状态查询`, () => {
    test('订单号编码且多次查询只读取一次认证', async () => {
      const calls = installHost()
      installFetch(async (url, init) => {
        expect(String(url)).toBe(`https://profer.example${path}?orderId=a%26b%3F%E4%B8%AD`)
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token')
        return Response.json({ status: 'paid', amountRmb: 1000 })
      })
      const reader = await createReader('a&b?中')
      expect(reader).not.toBeNull()
      expect((await reader?.())?.status).toBe('paid')
      await reader?.()
      expect(calls.authCalls).toBe(1)
    })
    test('未登录没有 reader', async () => {
      installHost(false)
      expect(await createReader('order')).toBeNull()
    })
    for (const failure of ['http', 'json', 'network'] as const) {
      test(`${failure} 返回 null，下一次查询可恢复`, async () => {
        installHost()
        const reader = await createReader('order')
        installFetch(async () => {
          if (failure === 'network') throw new Error('断网')
          return new Response('invalid', { status: failure === 'http' ? 500 : 200 })
        })
        expect(await reader?.()).toBeNull()
        installFetch(async () => Response.json({ status: 'paid' }))
        expect((await reader?.())?.status).toBe('paid')
      })
    }
  })
}

describe('支付页入口', () => {
  test('HTTP(S) 可打开，其他地址不会调用宿主', async () => {
    const opened: string[] = []
    installHost(true, async (url) => { opened.push(url) })
    for (const url of ['https://pay.example', 'http://pay.example', 'javascript:alert(1)', 'file:///tmp/a', '']) {
      await openCreditsPaymentPage(url)
    }
    expect(opened).toEqual(['https://pay.example', 'http://pay.example'])
  })
  test('宿主打开失败传回页面', async () => {
    installHost(true, async () => { throw new Error('打开失败') })
    await expect(openCreditsPaymentPage('https://pay.example')).rejects.toThrow('打开失败')
  })
})
