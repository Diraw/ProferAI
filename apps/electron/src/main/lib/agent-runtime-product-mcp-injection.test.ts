/**
 * B8 单元测试：产品 MCP 注入端口的**规则**与**失败语义**（等价性对照在 `.parity.test.ts`）。
 *
 * 这里只覆盖三件事：
 * 1. 纯决策函数的**原因码**（矩阵对照只比较「进/不进」，原因码只能在这里逐条锁住）；
 * 2. 授权根组合规则（旧链那四行拼接的逐条替身）；
 * 3. 执行器不变量：缺端口 / 计划抛错 / 缺能力 / 注入抛错 / 静默无产物，五种情形互不混淆；
 *    以及「只 import 不调用」时零副作用（懒加载是模块环 TDZ 的前提）。
 */

import { describe, expect, test } from 'bun:test'
import {
  PRODUCT_MCP_INJECTION_ORDER,
  PRODUCT_MCP_UNAVAILABLE_LOG_PREFIX,
  ProductMcpCapabilityMissingError,
  ProductMcpCapabilityUnavailableError,
  buildProductMcpInjectorArgs,
  composeBrowserAllowedRoots,
  composeImageOutputAllowedRoots,
  composePreviewAllowedRoots,
  createElectronProductMcpInjectionPort,
  planProductMcpServers,
  runProductMcpInjection,
  type ProductMcpHostCapabilities,
  type ProductMcpInjectionContext,
  type ProductMcpInjector,
  type ProductMcpPlanInput,
} from './agent-runtime-product-mcp-injection'
import type { ClaudeSdkNamespace, McpServerTable } from './agent-runtime-mcp-injection'
import { readMainSource } from './runtime-migration-parity/support/compile-slice'

const FULL: ProductMcpPlanInput = {
  promptMode: 'standard',
  runtime: 'claude',
  disabledToolGroups: [],
  hasWorkspace: true,
  hasSessionCwd: true,
  pptCapabilityActive: true,
}

function reasonsOf(input: Partial<ProductMcpPlanInput>): Record<string, string> {
  return Object.fromEntries(planProductMcpServers({ ...FULL, ...input }).map(entry => [entry.id, entry.reason]))
}

const CONTEXT: ProductMcpInjectionContext = {
  sessionId: 'unit-session',
  workspaceId: 'unit-workspace',
  workspaceSlug: 'unit-workspace',
  agentCwd: '/unit/session-cwd',
  triggeredBy: 'user',
  disabledTools: ['WebSearch'],
}

function fullCapabilities(): ProductMcpHostCapabilities {
  return {
    visualization: { storageDir: '/unit/visualizations', allowedRoots: ['/unit/session-cwd'], onUpdate: () => {}, assertCanPresent: () => {} },
    'file-preview': { allowedRoots: ['/unit/session-cwd'], open: async () => ({}) as never, inspect: async () => ({}) as never },
    'image-output-roots': { allowedRoots: ['/unit/session-cwd'] },
    'ai-image-generation': { isGptImageAvailable: () => true, onGenerationUpdate: () => {} },
    clipboard: true,
    browser: { allowedRoots: ['/unit/session-cwd'] },
  }
}

function recordingInjectors(): { injectors: Record<string, ProductMcpInjector>, calls: string[] } {
  const calls: string[] = []
  const injectors = Object.fromEntries(PRODUCT_MCP_INJECTION_ORDER.map(id => [
    id,
    (async (_sdk: ClaudeSdkNamespace, table: McpServerTable) => {
      calls.push(id)
      table[id] = { registered: true }
    }) as ProductMcpInjector,
  ])) as Record<string, ProductMcpInjector>
  return { injectors, calls }
}

describe('B8 · 计划原因码逐条对齐旧链的 if 条件', () => {
  test('light 提示词模式：整块跳过（所有服务器都是 prompt-mode-light）', () => {
    expect(reasonsOf({ promptMode: 'light' })).toEqual(Object.fromEntries([
      ...PRODUCT_MCP_INJECTION_ORDER.map(id => [id, 'prompt-mode-light']),
    ]))
  })

  test('runtime 为 pi：只有 image-output / ppt-delivery 没有 claude 门禁', () => {
    expect(reasonsOf({ runtime: 'pi' })).toEqual({
      visualization: 'runtime-unsupported',
      'agent-preview': 'runtime-unsupported',
      'agent-image-output': 'enabled',
      'agent-gpt-image': 'runtime-unsupported',
      'agent-skin': 'runtime-unsupported',
      'ppt-delivery': 'enabled',
      clipboard: 'runtime-unsupported',
      browser: 'runtime-unsupported',
    })
  })

  test('缺工作区 / 缺会话工作目录：上下文类服务器是 context-missing，preview 仍启用', () => {
    for (const patch of [{ hasWorkspace: false }, { hasSessionCwd: false }] as const) {
      expect(reasonsOf(patch)).toEqual({
        visualization: 'context-missing',
        'agent-preview': 'enabled',
        'agent-image-output': 'context-missing',
        'agent-gpt-image': 'context-missing',
        'agent-skin': 'context-missing',
        'ppt-delivery': 'enabled',
        clipboard: 'enabled',
        browser: 'enabled',
      })
    }
  })

  test('PPT 门禁关闭：只有 ppt-delivery 受影响（工具组禁用不参与该判定）', () => {
    expect(reasonsOf({ pptCapabilityActive: false })).toMatchObject({
      'ppt-delivery': 'context-missing',
      visualization: 'enabled',
      'agent-preview': 'enabled',
      'agent-image-output': 'enabled',
      'agent-gpt-image': 'enabled',
      'agent-skin': 'enabled',
      clipboard: 'enabled',
      browser: 'enabled',
    })
  })

  test('工具组禁用：同组服务器一起进 skipped，且 reason 是 tool-group-disabled', () => {
    expect(reasonsOf({ disabledToolGroups: ['preview'] })).toMatchObject({
      visualization: 'tool-group-disabled',
      'agent-preview': 'tool-group-disabled',
    })
    expect(reasonsOf({ disabledToolGroups: ['image'] })).toMatchObject({
      'agent-image-output': 'tool-group-disabled',
      'agent-gpt-image': 'tool-group-disabled',
      'agent-skin': 'tool-group-disabled',
    })
    expect(reasonsOf({ disabledToolGroups: ['clipboard', 'browser'] })).toMatchObject({
      clipboard: 'tool-group-disabled',
      browser: 'tool-group-disabled',
    })
  })

  test('优先级与旧链书写顺序一致：light > runtime > 工具组 > 上下文', () => {
    // 同时 light + pi + 禁用 + 缺上下文时，先报 prompt-mode-light。
    expect(reasonsOf({
      promptMode: 'light',
      runtime: 'pi',
      disabledToolGroups: ['preview', 'image', 'clipboard', 'browser'],
      hasWorkspace: false,
      hasSessionCwd: false,
      pptCapabilityActive: false,
    }).visualization).toBe('prompt-mode-light')
    // 非 light + pi + 禁用 preview：runtime 在工具组之前。
    expect(reasonsOf({ runtime: 'pi', disabledToolGroups: ['preview'] })['agent-preview']).toBe('runtime-unsupported')
    // claude + 禁用 preview + 缺上下文：工具组在上下文之前。
    expect(reasonsOf({ disabledToolGroups: ['preview'], hasWorkspace: false }).visualization).toBe('tool-group-disabled')
  })
})

describe('B8 · 授权根组合规则（旧链四行拼接的逐条替身）', () => {
  const roots = {
    agentCwd: '/unit/session-cwd',
    workspaceId: 'unit-workspace',
    workspaceSlug: 'unit-workspace',
    attachedDirectories: ['/unit/attached', '/unit/session-cwd'],
    productArtifactDirectories: ['/unit/product-artifacts'],
  }

  test('preview 根：有工作区且会话工作目录存在时把 cwd 放在最前（不去重）', () => {
    expect(composePreviewAllowedRoots(roots)).toEqual([
      '/unit/session-cwd',
      '/unit/attached',
      '/unit/session-cwd',
      '/unit/product-artifacts',
    ])
  })

  test('preview 根：缺工作区或缺 cwd 时不加前缀（只留附加目录 + 产物目录）', () => {
    expect(composePreviewAllowedRoots({ ...roots, workspaceSlug: undefined })).toEqual([
      '/unit/attached',
      '/unit/session-cwd',
      '/unit/product-artifacts',
    ])
    expect(composePreviewAllowedRoots({ ...roots, agentCwd: undefined })).toEqual([
      '/unit/attached',
      '/unit/session-cwd',
      '/unit/product-artifacts',
    ])
  })

  test('image-output 根：仅当有工作区且有 cwd 时非空（否则空数组，不是「只有附加目录」）', () => {
    expect(composeImageOutputAllowedRoots(roots)).toEqual(composePreviewAllowedRoots(roots))
    expect(composeImageOutputAllowedRoots({ ...roots, workspaceSlug: undefined })).toEqual([])
    expect(composeImageOutputAllowedRoots({ ...roots, agentCwd: undefined })).toEqual([])
  })

  test('browser 根：看 workspaceId（不是 workspaceSlug），去重并过滤空串', () => {
    expect(composeBrowserAllowedRoots(roots)).toEqual([
      '/unit/session-cwd',
      '/unit/attached',
      '/unit/product-artifacts',
    ])
    // workspaceSlug 缺失但 workspaceId 存在：仍然带 cwd 前缀（与 preview 根不同）。
    expect(composeBrowserAllowedRoots({ ...roots, workspaceSlug: undefined })).toEqual([
      '/unit/session-cwd',
      '/unit/attached',
      '/unit/product-artifacts',
    ])
    // 无 workspaceId：不打 cwd 前缀；空串被过滤。
    expect(composeBrowserAllowedRoots({ ...roots, workspaceId: undefined, agentCwd: '' })).toEqual([
      '/unit/attached',
      '/unit/session-cwd',
      '/unit/product-artifacts',
    ])
  })
})

describe('B8 · 执行器失败语义与纯函数契约', () => {
  const request = () => ({
    context: CONTEXT,
    mcpServers: {} as McpServerTable,
    sdk: {} as ClaudeSdkNamespace,
    planInput: FULL,
    capabilities: fullCapabilities(),
  })

  test('计划抛错：逐条记 plan-failed（带 detail），不整体失败、不产生半套结果', async () => {
    const port = {
      plan: () => { throw new Error('plan boom') },
      inject: async () => {},
    }
    const outcome = await runProductMcpInjection(port, request())
    expect(outcome.injected).toEqual([])
    expect(outcome.skipped).toEqual([])
    expect(outcome.unavailable.map(entry => [entry.id, entry.reason, entry.detail])).toEqual(
      PRODUCT_MCP_INJECTION_ORDER.map(id => [id, 'plan-failed', 'plan boom']),
    )
  })

  test('端口缺失：portAvailable=false + 计划内条目全部 port-missing，skipped 仍按策略给出', async () => {
    const outcome = await runProductMcpInjection(undefined, { ...request(), planInput: { ...FULL, pptCapabilityActive: false, disabledToolGroups: ['clipboard'] } })
    expect(outcome.portAvailable).toBe(false)
    expect(outcome.injected).toEqual([])
    expect(outcome.skipped).toEqual([
      { id: 'ppt-delivery', reason: 'context-missing' },
      { id: 'clipboard', reason: 'tool-group-disabled' },
    ])
    expect(outcome.unavailable.map(entry => entry.reason)).toEqual([
      'port-missing', 'port-missing', 'port-missing', 'port-missing', 'port-missing', 'port-missing',
    ])
  })

  test('错误类型可区分：缺能力与能力不可用不是同一个错误（执行器据此分别记录）', () => {
    expect(new ProductMcpCapabilityMissingError('clipboard').capability).toBe('clipboard')
    expect(new ProductMcpCapabilityUnavailableError('ai-image-generation').detail).toBe('ai-image-generation')
    expect(new ProductMcpCapabilityMissingError('browser')).toBeInstanceOf(Error)
    expect(new ProductMcpCapabilityUnavailableError('x')).toBeInstanceOf(Error)
  })

  test('参数构造器在缺能力时抛出缺能力错误（直接调用者不会拿到半套参数）', async () => {
    await expect(buildProductMcpInjectorArgs('browser', { ...request(), capabilities: {} }))
      .rejects.toBeInstanceOf(ProductMcpCapabilityMissingError)
    await expect(buildProductMcpInjectorArgs('clipboard', { ...request(), capabilities: {} }))
      .rejects.toBeInstanceOf(ProductMcpCapabilityMissingError)
  })

  test('ppt-delivery 没有位置上下文（旧链只有 disabledTools 一个参数）', async () => {
    expect(await buildProductMcpInjectorArgs('ppt-delivery', request())).toEqual([['WebSearch']])
  })

  test('默认端口的 plan 与纯函数同源（不是第二份条件）', () => {
    const port = createElectronProductMcpInjectionPort()
    for (const patch of [{}, { runtime: 'pi' as const }, { promptMode: 'light' as const }, { hasWorkspace: false }] as const) {
      const input = { ...FULL, ...patch }
      expect(port.plan(input)).toEqual(planProductMcpServers(input))
    }
  })

  test('日志前缀稳定（宿主日志可检索「该能力不可用」）', () => {
    expect(PRODUCT_MCP_UNAVAILABLE_LOG_PREFIX).toBe('[Agent 产品 MCP] 能力不可用')
  })

  test('只 import 不调用时零副作用：本模块不静态 import 任何产品工具模块（懒加载是防 TDZ 的前提）', () => {
    const source = readMainSource('agent-runtime-product-mcp-injection.ts')
    const staticProductImports = source
      .split('\n')
      .filter(line => /^import\s/.test(line) && /\.\/(agent-visualization|agent-preview|agent-image-output|agent-gpt-image|agent-skin|ppt-delivery|claude-clipboard|claude-browser)/.test(line))
    expect(staticProductImports).toEqual([])
    // 真实注入器只能出现在调用期动态 import 里。
    expect(source).toContain("import('./agent-visualization-tools')")
    expect(source).toContain("import('./claude-browser-tools')")
  })

  test('注入器覆盖表是可选依赖：提供了全部 8 条就不会加载默认注入器模块', async () => {
    const { injectors, calls } = recordingInjectors()
    const port = createElectronProductMcpInjectionPort({ injectors })
    const outcome = await runProductMcpInjection(port, request())
    expect(outcome.injected).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
    expect(calls).toEqual([...PRODUCT_MCP_INJECTION_ORDER])
  })

  test('注入器逐条失败隔离：前一条抛错不影响后一条成功', async () => {
    const { injectors, calls } = recordingInjectors()
    const port = createElectronProductMcpInjectionPort({
      injectors: {
        ...injectors,
        visualization: async () => { throw new Error('vis boom') },
        'agent-preview': async () => { throw new Error('preview boom') },
      },
    })
    const outcome = await runProductMcpInjection(port, request())
    expect(outcome.unavailable).toEqual([
      { id: 'visualization', reason: 'injector-failed', detail: 'vis boom' },
      { id: 'agent-preview', reason: 'injector-failed', detail: 'preview boom' },
    ])
    expect(outcome.injected).toEqual(['agent-image-output', 'agent-gpt-image', 'agent-skin', 'ppt-delivery', 'clipboard', 'browser'])
    expect(calls).not.toContain('visualization')
  })

  test('缺能力只影响该条：其余服务器照常注入（不整体失败）', async () => {
    const { injectors } = recordingInjectors()
    const port = createElectronProductMcpInjectionPort({ injectors })
    const capabilities = fullCapabilities()
    delete capabilities.browser
    const outcome = await runProductMcpInjection(port, { ...request(), capabilities })
    expect(outcome.unavailable).toEqual([{ id: 'browser', reason: 'capability-missing', detail: 'browser' }])
    expect(outcome.injected).toContain('clipboard')
  })
})
