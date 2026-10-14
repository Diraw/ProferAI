import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  creditsBalanceAtom,
  creditsBalancePackageAtom,
  creditsBalanceReferralAtom,
  creditsBalancePurchasedAtom,
  creditsLifetimeConsumedAtom,
  creditCycleSummaryAtom,
  membershipTierAtom,
  isVipAtom,
  multiplierAtom,
  inviteCodeAtom,
  subscriptionAtom,
  refreshCreditsInto,
} from '@/domains/credits/credits-state'
import { creditsBalanceAtom as legacyBalanceAtom } from '@/atoms/credits-atoms'
import { refreshCreditsInto as legacyRefresh } from './useCreditsLoader'

const originalFetch = globalThis.fetch

/** 保留 Bun fetch 的静态方法，让测试桩满足完整类型。 */
function installFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}
const originalNavigator = globalThis.navigator
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

function setOnline(online: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: online },
  })
}

function installWindow(commercial = true, authenticated = true): void {
  ;(globalThis as unknown as {
    window: { electronAPI: { getCommercialMode: () => Promise<boolean>; auth: { getTeamAuth: () => Promise<{ baseUrl: string; token: string } | null> } } }
  }).window = {
    electronAPI: {
      getCommercialMode: async () => commercial,
      auth: { getTeamAuth: async () => authenticated ? { baseUrl: 'https://profer.example', token: 'token' } : null },
    },
  }
}

describe('refreshCreditsInto', () => {
  beforeEach(() => {
    setOnline(true)
    installWindow()
    globalThis.fetch = originalFetch
  })

  test('离线时跳过余额请求并保留已有快照', async () => {
    const store = createStore()
    store.set(creditsBalanceAtom, 12)
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      throw new Error('should not fetch while offline')
    })
    setOnline(false)

    await refreshCreditsInto(store)

    expect(fetchCalls).toBe(0)
    expect(store.get(creditsBalanceAtom)).toBe(12)
  })

  test('网络恢复后可以重新同步余额', async () => {
    const store = createStore()
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({ balance: 8.5, balancePackage: 6 }), { status: 200 })
    })

    setOnline(false)
    await refreshCreditsInto(store)
    setOnline(true)
    await refreshCreditsInto(store)

    expect(fetchCalls).toBe(1)
    expect(store.get(creditsBalanceAtom)).toBe(8.5)
    expect(store.get(creditsBalancePackageAtom)).toBe(6)
  })

  test('并发刷新共享同一个余额请求', async () => {
    const firstStore = createStore()
    const secondStore = createStore()
    let fetchCalls = 0
    let resolveFetch!: (response: Response) => void
    installFetch(() => {
      fetchCalls += 1
      return new Promise<Response>((resolve) => { resolveFetch = resolve })
    })

    const first = refreshCreditsInto(firstStore)
    const second = refreshCreditsInto(secondStore)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchCalls).toBe(1)
    resolveFetch(new Response(JSON.stringify({ balance: 3.2 }), { status: 200 }))
    await Promise.all([first, second])

    expect(firstStore.get(creditsBalanceAtom)).toBe(3.2)
    expect(secondStore.get(creditsBalanceAtom)).toBe(3.2)
  })

  test('余额请求失败时不把已有余额重置为零', async () => {
    const store = createStore()
    store.set(creditsBalanceAtom, 7)
    installFetch(async () => { throw new Error('offline') })

    setOnline(false)
    await refreshCreditsInto(store)

    expect(store.get(creditsBalanceAtom)).toBe(7)
    expect(store.get(creditsLifetimeConsumedAtom)).toBe(0)
  })

  test('历史入口和领域入口使用同一组 atoms 与刷新函数', () => {
    expect(legacyBalanceAtom).toBe(creditsBalanceAtom)
    expect(legacyRefresh).toBe(refreshCreditsInto)
  })

  for (const scenario of ['disabled', 'unauthenticated', '401', '403'] as const) {
    test(`${scenario} 清空全部账号快照`, async () => {
      installWindow(scenario !== 'disabled', scenario !== 'unauthenticated')
      const store = createStore()
      store.set(creditsBalanceAtom, 12)
      store.set(creditsLifetimeConsumedAtom, 5)
      store.set(creditsBalancePackageAtom, 7)
      store.set(creditsBalanceReferralAtom, 3)
      store.set(creditsBalancePurchasedAtom, 2)
      store.set(membershipTierAtom, 'pro')
      store.set(isVipAtom, true)
      store.set(multiplierAtom, 0.8)
      store.set(inviteCodeAtom, 'old-account')
      store.set(subscriptionAtom, { hasSubscription: true, plan: 'pro' })
      store.set(creditCycleSummaryAtom, {
        balancePackage: 7, balanceReferral: 3, balancePurchased: 2,
        packageConsumed: 1, referralConsumed: 1, purchasedConsumed: 1,
        packageAllocated: 8, referralAllocated: 4, purchasedAllocated: 3,
        totalAllocated: 15, packagePeriodStartsAt: 1, packagePeriodEndsAt: 2,
        monthStartsAt: 1, monthEndsAt: 2,
      })
      let calls = 0
      installFetch(async () => {
        calls += 1
        return new Response('', { status: Number(scenario) })
      })
      await refreshCreditsInto(store)
      expect(calls).toBe(scenario === '401' || scenario === '403' ? 1 : 0)
      expect(store.get(creditsBalanceAtom)).toBeNull()
      expect(store.get(creditsLifetimeConsumedAtom)).toBe(0)
      expect(store.get(creditsBalancePackageAtom)).toBe(0)
      expect(store.get(creditsBalanceReferralAtom)).toBe(0)
      expect(store.get(creditsBalancePurchasedAtom)).toBe(0)
      expect(store.get(creditCycleSummaryAtom)).toBeNull()
      expect(store.get(membershipTierAtom)).toBe('free')
      expect(store.get(isVipAtom)).toBe(false)
      expect(store.get(multiplierAtom)).toBe(1)
      expect(store.get(inviteCodeAtom)).toBeNull()
      expect(store.get(subscriptionAtom)).toBeNull()
    })
  }

  for (const failure of ['network', '500', 'invalid-json'] as const) {
    test(`${failure} 保留快照且后续刷新可恢复`, async () => {
      const store = createStore()
      store.set(creditsBalanceAtom, 12)
      store.set(subscriptionAtom, { hasSubscription: true, plan: 'pro' })
      installFetch(async () => {
        if (failure === 'network') throw new Error('网络失败')
        return new Response('invalid-json', { status: failure === '500' ? 500 : 200 })
      })
      await refreshCreditsInto(store)
      expect(store.get(creditsBalanceAtom)).toBe(12)
      expect(store.get(subscriptionAtom)?.plan).toBe('pro')
      installFetch(async () => Response.json({ balance: 9, subscription: null }))
      await refreshCreditsInto(store)
      expect(store.get(creditsBalanceAtom)).toBe(9)
      expect(store.get(subscriptionAtom)).toBeNull()
    })
  }

  afterAll(() => {
    if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    })
  })
})
