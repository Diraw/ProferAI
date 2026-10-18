import { describe, expect, test, mock } from 'bun:test'

let commercialBuild = false
let commercialMode = false

mock.module('./build-target', () => ({ isCommercialBuild: () => commercialBuild }))
mock.module('./channel-manager', () => ({ isCommercialMode: () => commercialMode }))

const { shouldUseCommercialBearerAuth, shouldUseManagedCommercialRoute } = await import('./commercial-routing-policy')

const official = { id: 'newapi-official', serverManaged: true, directDataPlane: false }
const selfConfigured = { id: 'custom', serverManaged: false, directDataPlane: false }

describe('商业旁侧路由策略', () => {
  test('OSS 构建不把官方渠道路由到商业代管', () => {
    commercialBuild = false
    commercialMode = false
    expect(shouldUseManagedCommercialRoute(official)).toBe(false)
    expect(shouldUseCommercialBearerAuth(official)).toBe(false)
  })

  test('商业构建只让官方代管渠道进入旁侧路由', () => {
    commercialBuild = true
    commercialMode = false
    expect(shouldUseManagedCommercialRoute(official)).toBe(true)
    expect(shouldUseManagedCommercialRoute(selfConfigured)).toBe(false)
    expect(shouldUseCommercialBearerAuth(official)).toBe(true)
  })

  test('direct data plane 保留官方渠道直连，但仍使用 Bearer 认证策略', () => {
    commercialBuild = true
    expect(shouldUseManagedCommercialRoute({ ...official, directDataPlane: true })).toBe(true)
    expect(shouldUseCommercialBearerAuth({ ...official, directDataPlane: true })).toBe(true)
  })

  test('OSS 构建收到服务端商业模式标记时仍使用同一商业策略', () => {
    commercialBuild = false
    commercialMode = true
    expect(shouldUseManagedCommercialRoute(official)).toBe(true)
  })
})
