/**
 * 旧 `?token=` 手动连接路径的链路信任判定。
 *
 * 手动连接用的是桌面共享 Token，不是每设备凭据，所以只允许在可信链路上使用：
 * - 端到端 TLS（自建穿透的 pinned 链路、内置 FRP、公网自签监听）；
 * - 私网直连（同一局域网，用户自己的 Wi-Fi）；
 * - 本机反代（域名场景由 Caddy/Nginx 终止 TLS 后转发到 127.0.0.1，此时会带转发头）。
 *
 * 公网明文一律拒绝：Token 不能在明文链路上传输。
 */
import { isPrivateHost } from '@profer/shared'

export interface LegacyTransportInput {
  /** 对端地址（已去掉 IPv4-mapped 前缀）。 */
  peer: string
  /** 这条连接是否走端到端 TLS（服务端已确认的自签/pinned 链路）。 */
  encrypted: boolean
  /** 请求是否带 Forwarded / X-Forwarded-* 头。 */
  hasProxyHeaders: boolean
}

export function isTrustedLegacyTransport(input: LegacyTransportInput): boolean {
  if (input.encrypted) return true
  if (!isPrivateHost(input.peer)) return false
  const loopback = input.peer === '127.0.0.1' || input.peer === '::1'
  // 转发头只在本机反代场景可信；私网其它主机带转发头视为不可信（防伪造来源）。
  return !input.hasProxyHeaders || loopback
}
