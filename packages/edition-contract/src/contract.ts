import type { Channel } from '@profer/shared'

/** 发行版标识：oss=开源版，commercial=商业版。 */
export type EditionId = 'oss' | 'commercial'

/**
 * 一次商业账号会话的只读快照。
 *
 * 刷新、持久化和 Team Server 细节都由 AccountProvider 的实现负责；
 * 执行链只消费快照，不感知具体服务端。
 */
export interface EditionAuthSession {
  baseUrl: string
  token: string
  proxyToken?: string
  membershipTier?: string
  teamEmail?: string
  teamAccountId?: string
}

/** 商业账号能力。OSS 实现可以整体返回 null。 */
export interface EditionAccountProvider {
  /** 当前有效登录态；实现负责在过期时刷新。未登录返回 null。 */
  getSession(): Promise<EditionAuthSession | null>
  /** 代管令牌失效后的恢复路径；不提供恢复能力的发行版返回 null。 */
  recoverSession(): Promise<EditionAuthSession | null>
}

/**
 * 路由判定只需要渠道的最小投影。
 *
 * 不直接使用完整 Channel，避免契约层绑定渠道配置的其余字段。
 */
export type EditionChannelRef = Pick<Channel, 'id' | 'serverManaged' | 'directDataPlane'>

export interface ManagedRouteOptions {
  /** 为 true 时，directDataPlane 渠道不进入代管通道。 */
  respectDirectDataPlane?: boolean
}

/** 凭据路由策略：只回答“走哪条路”，不解析账号、额度或供应商错误。 */
export interface EditionCredentialPolicy {
  /** 是否应把该渠道的请求路由到官方代管通道。 */
  shouldUseManagedRoute(channel: EditionChannelRef, options?: ManagedRouteOptions): boolean
  /** 是否应使用 Bearer 代管凭据（而非本地 API Key）。 */
  shouldUseBearerAuth(channel: EditionChannelRef): boolean
}

/**
 * 一个发行版向执行链暴露的全部商业能力。
 *
 * 阶段 A 只收口 account 与 credentials。entitlements、update、remote、branding
 * 在阶段 B 接入时再扩展本接口，避免提前引入没有消费者的空实现。
 */
export interface EditionProviders {
  id: EditionId
  account: EditionAccountProvider
  credentials: EditionCredentialPolicy
}

/** 代管通道统一使用 proxyToken 优先、token 兜底的 Bearer 凭据。 */
export function resolveEditionBearerToken(session: EditionAuthSession): string {
  return session.proxyToken || session.token
}
