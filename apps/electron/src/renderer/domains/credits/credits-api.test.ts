import { afterEach, describe, expect, test } from 'bun:test'
import { claimCreditsDrip, requestCreditsUsage } from './credits-api'
import type { CreditsUsageLog, CreditsModelUsage } from './credits-types'

const originalFetch = globalThis.fetch

/** 保留 Bun fetch 的静态方法，让测试桩满足完整类型。 */
function installFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

function installAuth(authenticated = true): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        auth: { getTeamAuth: async () => authenticated ? { baseUrl: 'https://profer.example', token: 'fixture-token' } : null },
      },
    },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

const log: CreditsUsageLog = {
  id: 'request', model: 'model', prompt_tokens: 1, completion_tokens: 2,
  total_tokens: 3, cost_credits: 50000, duration_ms: 100, success: 1,
  stream: 1, created_at: 1,
}
const model: CreditsModelUsage = {
  model: 'model', requests: 1, total_tokens: 3, prompt_tokens: 1,
  completion_tokens: 2, total_cost: 50000,
}

describe('积分用量 API', () => {
  test('用量查询使用原有请求范围与认证 header', async () => {
    installAuth()
    const urls: string[] = []
    installFetch(async (input, init) => {
      urls.push(String(input))
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token')
      return Response.json(urls.length === 1 ? { logs: [log] } : [model])
    })
    expect(await requestCreditsUsage()).toEqual({ logs: [log], modelUsage: [model] })
    expect(urls).toEqual([
      'https://profer.example/v1/account/credits/usage?limit=30',
      'https://profer.example/v1/account/credits/usage-by-model?days=30',
    ])
  })

  test('未登录不发起用量或领取请求', async () => {
    installAuth(false)
    let calls = 0
    installFetch(async () => { calls++; throw new Error('不应请求') })
    expect(await requestCreditsUsage()).toEqual({})
    expect(await claimCreditsDrip()).toBeNull()
    expect(calls).toBe(0)
  })

  test('日志 HTTP 失败只更新成功的模型统计', async () => {
    installAuth()
    let calls = 0
    installFetch(async () => ++calls === 1
      ? new Response('', { status: 500 })
      : Response.json([model]))
    expect(await requestCreditsUsage()).toEqual({ modelUsage: [model] })
  })

  for (const failure of ['http', 'network', 'invalid-json'] as const) {
    test(`模型查询 ${failure} 失败仍返回已读到的日志`, async () => {
      installAuth()
      let calls = 0
      installFetch(async () => {
        if (++calls === 1) return Response.json({ logs: [log] })
        if (failure === 'network') throw new Error('网络失败')
        return new Response('invalid', { status: failure === 'http' ? 500 : 200 })
      })
      expect(await requestCreditsUsage()).toEqual({ logs: [log] })
    })
  }

  test('成功的空结果与失败字段区分，允许清空已有用量', async () => {
    installAuth()
    let calls = 0
    installFetch(async () => Response.json(++calls === 1 ? {} : null))
    expect(await requestCreditsUsage()).toEqual({ logs: [], modelUsage: [] })
  })
})

describe('drip 领取 API', () => {
  test('POST 领取并返回服务端结果', async () => {
    installAuth()
    installFetch(async (input, init) => {
      expect(String(input)).toBe('https://profer.example/v1/account/subscription/claim-drip')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token')
      return Response.json({ claimed: true, message: '已领取' })
    })
    expect(await claimCreditsDrip()).toEqual({ claimed: true, message: '已领取' })
  })

  test('暂无额度时保留服务端提示', async () => {
    installAuth()
    installFetch(async () => Response.json({ claimed: false, message: '暂无额度' }))
    expect(await claimCreditsDrip()).toEqual({ claimed: false, message: '暂无额度' })
  })

  for (const failure of ['http', 'network', 'invalid-json'] as const) {
    test(`${failure} 失败向调用方抛出，不能误报为未登录`, async () => {
      installAuth()
      installFetch(async () => {
        if (failure === 'network') throw new Error('网络失败')
        return new Response('invalid', { status: failure === 'http' ? 500 : 200 })
      })
      await expect(claimCreditsDrip()).rejects.toThrow()
    })
  }
})
