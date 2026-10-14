import type {
  CreditsAuth,
  CreditsModelUsage,
  CreditsRequestResult,
  CreditsResponse,
  CreditsUsageLog,
  CreditsUsageResponse,
  DripClaimResponse,
  CreditMutationResult,
  RechargeConfig,
  RechargeOrderResponse,
  RechargePayType,
  RechargeStatusResponse,
  PricingData,
  RedeemResponse,
  SubscriptionPurchaseInput,
  SubscriptionPurchaseResponse,
  SubscriptionPurchaseStatusResponse,
} from './credits-types'

let creditsRequest: Promise<CreditsRequestResult> | null = null

function isNetworkAvailable(): boolean {
  // navigator.onLine 只是连接提示；真正请求仍需处理服务端/DNS 失败。
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

function getAuth(): Promise<CreditsAuth | null> {
  return window.electronAPI.auth.getTeamAuth()
}

function fetchAccount(auth: CreditsAuth, path: string, method = 'GET', body?: object): Promise<Response> {
  return fetch(`${auth.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

/** 获取余额快照；非代管模式返回 disabled，并发调用共享同一个余额请求。 */
export async function requestCredits(): Promise<CreditsRequestResult> {
  const commercial = await window.electronAPI.getCommercialMode().catch(() => false)
  if (!commercial) return { kind: 'disabled' }
  if (!isNetworkAvailable()) return { kind: 'failed' }
  if (creditsRequest) return creditsRequest

  const pending = (async (): Promise<CreditsRequestResult> => {
    try {
      const auth = await getAuth()
      if (!auth) return { kind: 'unauthenticated' }
      if (!isNetworkAvailable()) return { kind: 'failed' }
      const response = await fetchAccount(auth, '/v1/account/credits')
      if (!response.ok) {
        return response.status === 401 || response.status === 403
          ? { kind: 'unauthorized' }
          : { kind: 'failed' }
      }
      return { kind: 'success', data: await response.json() as CreditsResponse }
    } catch {
      return { kind: 'failed' }
    }
  })()

  creditsRequest = pending
  try {
    return await pending
  } finally {
    creditsRequest = null
  }
}

/**
 * 获取额度页用量；只返回成功读取的字段，失败的部分保留页面已有快照。
 * 按原有顺序先查日志再查模型统计，第二项失败不丢弃已读到的日志。
 */
export async function requestCreditsUsage(): Promise<{
  logs?: CreditsUsageLog[]
  modelUsage?: CreditsModelUsage[]
}> {
  const usage: { logs?: CreditsUsageLog[]; modelUsage?: CreditsModelUsage[] } = {}
  try {
    const auth = await getAuth()
    if (!auth) return usage
    const logsResponse = await fetchAccount(auth, '/v1/account/credits/usage?limit=30')
    if (logsResponse.ok) {
      const data = await logsResponse.json() as CreditsUsageResponse
      usage.logs = data.logs ?? []
    }
    const modelsResponse = await fetchAccount(auth, '/v1/account/credits/usage-by-model?days=30')
    if (modelsResponse.ok) {
      const data = await modelsResponse.json() as CreditsModelUsage[] | null
      usage.modelUsage = data ?? []
    }
  } catch {
    // 用量查询失败时沿用已有快照，不影响余额展示。
  }
  return usage
}

/** 未登录返回 null；请求或解析失败继续交由调用方提示重试。 */
export async function claimCreditsDrip(): Promise<DripClaimResponse | null> {
  const auth = await getAuth()
  if (!auth) return null
  const response = await fetchAccount(auth, '/v1/account/subscription/claim-drip', 'POST')
  if (!response.ok) throw new Error(`claim-drip failed: ${response.status}`)
  return await response.json() as DripClaimResponse
}

/** 配置加载失败返回 null，由页面继续使用现有默认值。 */
async function requestConfig<T>(path: string): Promise<T | null> {
  try {
    const auth = await getAuth()
    if (!auth) return null
    const response = await fetchAccount(auth, path)
    if (!response.ok) return null
    return await response.json() as T
  } catch {
    return null
  }
}

export function requestRechargeConfig(): Promise<RechargeConfig | null> {
  return requestConfig('/v1/account/credits/recharge-config')
}

export function requestSubscriptionPricing(): Promise<PricingData | null> {
  return requestConfig('/v1/account/config/plans')
}

/** 业务拒绝返回服务端文案；网络与解析异常继续由页面显示原有重试提示。 */
async function postMutation<T extends { error?: string }>(
  path: string,
  body: object,
): Promise<CreditMutationResult<T>> {
  const auth = await getAuth()
  if (!auth) return { kind: 'unauthenticated' }
  const response = await fetchAccount(auth, path, 'POST', body)
  let data: T
  try {
    const parsed: unknown = await response.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('无效的账户响应')
    data = parsed as T
  } catch (error) {
    if (!response.ok) return { kind: 'failed' }
    throw error
  }
  if (!response.ok) return { kind: 'failed', message: data.error }
  return { kind: 'success', data }
}

export function redeemCredits(code: string): Promise<CreditMutationResult<RedeemResponse>> {
  return postMutation('/v1/account/redeem', { code })
}

/** 在线订单必须有可轮询的订单号，不能把损坏的成功响应当成有效订单。 */
function validateOrder<T extends { orderId?: string; payInfo?: { method?: string } }>(
  result: CreditMutationResult<T>,
  requiresOrder: (data: T) => boolean,
): CreditMutationResult<T> {
  if (result.kind === 'success' && requiresOrder(result.data)) {
    if (typeof result.data.orderId !== 'string' || !result.data.orderId.trim()) return { kind: 'failed' }
  }
  return result
}

export async function createRechargeOrder(
  amountRmb: number,
  payType: RechargePayType,
): Promise<CreditMutationResult<RechargeOrderResponse>> {
  const result = await postMutation<RechargeOrderResponse>('/v1/account/credits/recharge', { amountRmb, payType })
  return validateOrder(result, (data) => data.payInfo?.method === 'online')
}

export async function createSubscriptionPurchase(
  input: SubscriptionPurchaseInput,
): Promise<CreditMutationResult<SubscriptionPurchaseResponse>> {
  const result = await postMutation<SubscriptionPurchaseResponse>('/v1/account/subscription/purchase', input)
  return validateOrder(result, (data) => data.payInfo?.method !== 'manual')
}

/**
 * 在一轮支付轮询中复用同一次认证快照，组件只持有查询函数。
 * 查询失败返回 null；保留现有每 5 秒重试、最多 30 次的页面轮询策略。
 */
async function createStatusReader<T>(path: string): Promise<(() => Promise<T | null>) | null> {
  const auth = await getAuth()
  if (!auth) return null
  return async () => {
    try {
      const response = await fetchAccount(auth, path)
      if (!response.ok) return null
      return await response.json() as T
    } catch {
      return null
    }
  }
}

export function createRechargeStatusReader(orderId: string): Promise<(() => Promise<RechargeStatusResponse | null>) | null> {
  return createStatusReader(`/v1/account/credits/recharge/status?orderId=${encodeURIComponent(orderId)}`)
}

export function createSubscriptionStatusReader(orderId: string): Promise<(() => Promise<SubscriptionPurchaseStatusResponse | null>) | null> {
  return createStatusReader(`/v1/account/subscription/purchase/status?orderId=${encodeURIComponent(orderId)}`)
}

/** 支付页只允许 HTTP(S) 地址，错误交给页面保留现有提示。 */
export async function openCreditsPaymentPage(url: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) await window.electronAPI.openExternal(url)
}

