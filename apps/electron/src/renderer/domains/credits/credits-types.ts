/** 积分、充值与订阅接口共用的数据契约。 */
export interface AccountEntitlements {
  version: number
  edition: 'hosted' | 'self-hosted'
  tier: string
  isVip: boolean
  capabilities: {
    managed_model_pool: boolean
    self_config_api: boolean
    multi_workspace: boolean
  }
  limits: { maxWorkspaces: number | null; maxDevices: number | null }
}

export interface CreditCycleSummary {
  balancePackage: number
  balanceReferral: number
  balancePurchased: number
  packageConsumed: number
  referralConsumed: number
  purchasedConsumed: number
  packageAllocated: number
  referralAllocated: number
  purchasedAllocated: number
  totalAllocated: number
  packagePeriodStartsAt: number
  packagePeriodEndsAt: number | null
  monthStartsAt: number
  monthEndsAt: number
}

export interface SubscriptionStatus {
  hasSubscription: boolean
  plan?: string
  cycle?: string
  status?: string
  startedAt?: number
  expiresAt?: number
  welcomeBonusAmount?: number
  dailyDripRate?: number
  vipDiscountApplied?: boolean
  dripAvailableThisWeek?: number
  dripLastAccrualDate?: string | null
  dripLastClaimedDate?: string | null
  membershipTier?: string
  isVip?: boolean
  multiplier?: number
}

export type CreditsResponse = {
  balance?: number | null
  lifetimeConsumed?: number
  balancePackage?: number
  balanceReferral?: number
  balancePurchased?: number
  cycleSummary?: CreditCycleSummary | null
  membershipTier?: string
  isVip?: boolean
  multiplier?: number
  inviteCode?: string | null
  subscription?: SubscriptionStatus | null
  entitlements?: AccountEntitlements | null
}


export type CreditsRequestResult =
  | { kind: 'disabled' }
  | { kind: 'success'; data: CreditsResponse }
  | { kind: 'unauthenticated' }
  | { kind: 'unauthorized' }
  | { kind: 'failed' }

export interface CreditsAuth {
  baseUrl: string
  token: string
  teamEmail?: string
  teamAccountId?: string
}

export interface CreditsUsageLog {
  id: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_credits: number
  duration_ms: number
  success: number
  stream: number
  created_at: number
}

export interface CreditsModelUsage {
  model: string
  requests: number
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
  total_cost: number
}

export interface CreditsUsageResponse {
  logs?: CreditsUsageLog[]
}

export type DripClaimResponse = {
  claimed?: boolean
  message?: string
}

export interface RechargeConfig {
  enabled: boolean
  manualFallback: boolean
  rate: number
  presetsRmb: number[]
  customMinRmb: number
  customMaxRmb: number
  currency: string
  adminWechat: string
}

export interface RechargeOrderResponse {
  orderId?: string
  error?: string
  payInfo?: {
    method?: 'online' | 'manual' | string
    payUrl?: string
    qrcode?: string
    adminWechat?: string
  }
}

export interface RechargeStatusResponse {
  status?: 'paid' | 'cancelled' | 'expired' | string
  amountRmb?: number
}

export type RechargePayType = 'wxpay' | 'alipay'

export type CreditMutationResult<T> =
  | { kind: 'success'; data: T }
  | { kind: 'unauthenticated' }
  | { kind: 'failed'; message?: string }

export interface PlanPricing {
  id: string
  name: string
  monthlyRmb: number
  yearlyRmb: number
  welcomeBonus: number
  dailyDrip: number
}

export interface PricingData {
  plans: Record<'standard' | 'plus' | 'pro', PlanPricing>
  vip: { price: number; discount: number; extraDrip: number }
  adminWechat: string
}

export interface RedeemResponse {
  error?: string
  description?: string
}

export interface SubscriptionPurchaseInput {
  product: 'subscription' | 'vip'
  plan?: string
  cycle?: 'monthly' | 'yearly'
  payType: RechargePayType
}

export interface SubscriptionPurchaseResponse {
  orderId?: string
  error?: string
  payInfo?: {
    method?: 'online' | 'manual' | string
    payUrl?: string
    qrcode?: string
    adminWechat?: string
  }
}

export interface SubscriptionPurchaseStatusResponse {
  status?: 'paid' | 'cancelled' | 'expired' | string
}
