/**
 * 积分状态管理
 *
 * 积分体系：
 *   - 服务端 DB 存储 New API quota（500,000 quota = $1 货币单位）
 *   - API 返回 balance / lifetimeConsumed：货币单位（quota / 500000）
 *   - API 返回 cost_credits / total_cost：原始 quota（未除 500000）
 *   - 前端统一展示为"积分"：balance × 10 = 积分（保留 1 位小数），quota / 50000 = 积分
 *
 * 底层 credits 余额（quota 单位）不变，×10 / ÷50000 均为纯展示层换算。
 */
import { atom, type createStore } from 'jotai'
import type { CreditCycleSummary, SubscriptionStatus, AccountEntitlements } from './credits-types'
import { requestCredits } from './credits-api'
export type { CreditCycleSummary, SubscriptionStatus, AccountEntitlements } from './credits-types'

// ---- 单位换算常量 ----
/** New API quota → 积分除数：500,000 quota = 10 积分 → 50,000 quota = 1 积分 */
const QUOTA_PER_POINT = 50_000

/** 将原始 quota 值转换为积分（保留 3 位小数，最小 0.001） */
export function quotaToPoints(quota: number): number {
  if (!quota || quota <= 0) return 0
  return Math.max(0.001, Math.round((quota / QUOTA_PER_POINT) * 1000) / 1000)
}

/** 当前余额（null = 未加载，货币单位） */
export const creditsBalanceAtom = atom<number | null>(null)

/** 积分显示值 = 余额 × 10（保留 1 位小数） */
export const creditsPointsAtom = atom((get) => {
  const balance = get(creditsBalanceAtom)
  if (balance === null) return null
  return Math.round(balance * 100) / 10
})

/** 累计消耗（货币单位） */
export const creditsLifetimeConsumedAtom = atom<number>(0)

/** 累计消耗（积分单位，保留 1 位小数）= 累计消耗 × 10 */
export const creditsLifetimeConsumedPointsAtom = atom((get) => {
  const consumed = get(creditsLifetimeConsumedAtom)
  return Math.round(consumed * 100) / 10
})

/** 是否正在加载 */
export const creditsLoadingAtom = atom<boolean>(false)

// ---- 当前结算周期汇总（货币单位；服务端按套餐周期/中国自然月聚合） ----

/** null 表示接口尚未返回周期汇总，不能退回错误的历史累计分母。 */
export const creditCycleSummaryAtom = atom<CreditCycleSummary | null>(null)

// ---- 积分分账 ----
export const creditsBalancePackageAtom = atom<number>(0)
export const creditsBalanceReferralAtom = atom<number>(0)
export const creditsBalancePurchasedAtom = atom<number>(0)

// ---- 会员 ----
export const membershipTierAtom = atom<string>('free')
export const isVipAtom = atom<boolean>(false)
export const multiplierAtom = atom<number>(1.0)
export const inviteCodeAtom = atom<string | null>(null)

export const accountEntitlementsAtom = atom<AccountEntitlements | null>(null)

// ---- 阈值 ----
/** 积分偏低阈值：< 50 积分告警 */
export const CREDITS_LOW_POINTS = 50

/** 积分偏低 */
export const creditsLowAtom = atom((get) => {
  const points = get(creditsPointsAtom)
  return points !== null && points > 0 && points <= CREDITS_LOW_POINTS
})

/** 积分耗尽 */
export const creditsExhaustedAtom = atom((get) => {
  const points = get(creditsPointsAtom)
  return points !== null && points <= 0
})

// ---- 套餐订阅 ----

export const subscriptionAtom = atom<SubscriptionStatus | null>(null)

/** 本周可领 drip 积分数（保留 1 位小数） */
export const dripAvailablePointsAtom = atom((get) => {
  const sub = get(subscriptionAtom)
  if (!sub?.dripAvailableThisWeek) return 0
  return Math.round(sub.dripAvailableThisWeek / 5_000) / 10
})

/** 返回 Asia/Shanghai 时区的当天日期（YYYY-MM-DD），与服务端 getChinaDate() 对齐 */
function getChinaDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** 今日是否已领 drip */
export const dripClaimedTodayAtom = atom((get) => {
  const sub = get(subscriptionAtom)
  if (!sub?.dripLastClaimedDate) return false
  const today = getChinaDate()
  return sub.dripLastClaimedDate === today
})

/** 每日 drip 速率（积分） */
export const dailyDripRateAtom = atom((get) => {
  return get(subscriptionAtom)?.dailyDripRate ?? 0
})

// ---- 积分分桶（pts 单位，保留 1 位小数） ----
export const balancePackagePointsAtom = atom((get) => {
  const pkg = get(creditsBalancePackageAtom)
  return Math.round(pkg * 100) / 10
})

export const balanceReferralPointsAtom = atom((get) => {
  const ref = get(creditsBalanceReferralAtom)
  return Math.round(ref * 100) / 10
})

export const balancePurchasedPointsAtom = atom((get) => {
  const pur = get(creditsBalancePurchasedAtom)
  return Math.round(pur * 100) / 10
})

// ---- 透支 ----
/** 是否处于透支状态（总积分 < 0） */
export const isInOverdraftAtom = atom((get) => {
  const points = get(creditsPointsAtom)
  return points !== null && points < 0
})

/** 透支金额（积分绝对值，非透支则为 0） */
export const overdraftAmountAtom = atom((get) => {
  const points = get(creditsPointsAtom)
  return points !== null && points < 0 ? Math.abs(points) : 0
})

/** jotai store（useStore() / createStore() 的返回类型） */
type JotaiStore = ReturnType<typeof createStore>

/** 清空余额、会员和订阅，防止展示上一个账号的快照。 */
function clearCreditsState(store: JotaiStore): void {
  store.set(creditsBalanceAtom, null)
  store.set(creditsLifetimeConsumedAtom, 0)
  store.set(creditsBalancePackageAtom, 0)
  store.set(creditsBalanceReferralAtom, 0)
  store.set(creditsBalancePurchasedAtom, 0)
  store.set(creditCycleSummaryAtom, null)
  store.set(membershipTierAtom, 'free')
  store.set(isVipAtom, false)
  store.set(multiplierAtom, 1.0)
  store.set(inviteCodeAtom, null)
  store.set(subscriptionAtom, null)
  store.set(accountEntitlementsAtom, null)
}

/** 拉取一次余额并写入指定 store，供组件和全局事件监听共用。 */
export async function refreshCreditsInto(store: JotaiStore): Promise<void> {
  try {
    const result = await requestCredits()
    if (result.kind === 'disabled' || result.kind === 'unauthenticated' || result.kind === 'unauthorized') {
      // 认证已失效时不能保留上一个账号的余额或订阅状态；普通服务异常和断网仍保留旧快照。
      clearCreditsState(store)
      return
    }
    if (result.kind !== 'success') return
    const d = result.data
    // 当前用户本地账本余额：balance 可能为 null（非代管或查询失败）
    store.set(creditsBalanceAtom, d.balance ?? null)
    store.set(creditsLifetimeConsumedAtom, d.lifetimeConsumed ?? 0)
    // 积分分账 + 会员
    store.set(creditsBalancePackageAtom, d.balancePackage ?? 0)
    store.set(creditsBalanceReferralAtom, d.balanceReferral ?? 0)
    store.set(creditsBalancePurchasedAtom, d.balancePurchased ?? 0)
    // 服务端灰度或旧版本未返回时保持 null，界面会明确提示同步中，不能倒退到历史累计分母。
    store.set(creditCycleSummaryAtom, d.cycleSummary ?? null)
    store.set(membershipTierAtom, d.membershipTier ?? 'free')
    store.set(isVipAtom, !!d.isVip)
    store.set(multiplierAtom, d.multiplier ?? 1.0)
    store.set(inviteCodeAtom, d.inviteCode ?? null)
    // 订阅状态：服务端明确返回 null 时必须清除旧账号/已过期订阅的陈旧卡片。
    store.set(subscriptionAtom, d.subscription ?? null)
    store.set(accountEntitlementsAtom, d.entitlements ?? null)
  } catch {
    /* 静默：余额拉取失败不打扰用户 */
  }
}

