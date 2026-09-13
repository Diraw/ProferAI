import { describe, expect, mock, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', isPackaged: false },
  nativeTheme: { shouldUseDarkColors: true },
}))
mock.module('./skin-service', () => ({ getUserSkinDir: () => `${homedir()}/.profer-dev/skins` }))
let stagedPackage: { manifest: string; css: string; wallpaper: Buffer } | undefined
mock.module('./skin-manager-service', () => ({ installSkinFromFolder: (folder: string) => {
  stagedPackage = {
    manifest: readFileSync(`${folder}/manifest.json`, 'utf8'),
    css: readFileSync(`${folder}/skin.css`, 'utf8'),
    wallpaper: readFileSync(`${folder}/assets/wallpaper.png`),
  }
  return { ok: true, status: 'installed', skin: { id: 'test-skin', name: 'Test skin', tone: 'dark', contractVersion: 2, builtin: false } }
} }))
mock.module('./settings-service', () => ({ updateSettings: () => ({}) }))
mock.module('./titlebar-overlay', () => ({ updateWindowFrameAppearance: () => undefined }))
mock.module('./agent-image-output-service', () => ({ readAuthorizedAgentImage: async () => ({ absolutePath: '/safe/image.png', data: Buffer.from([0x89, 0x50]), filename: 'image.png', mediaType: 'image/png' }) }))

const { AGENT_SKIN_TOOL_NAME, injectAgentSkinMcpServer } = await import('./agent-skin-tools')

describe('Agent Profer skin tool', () => {
  test('Given a workspace-backed Claude session When injecting skin tools Then create_skin is available with CSS and wallpaper inputs', async () => {
    const captured: Array<{ name: string; parameters: unknown }> = []
    const sdk = {
      tool: (name: string, _description: string, parameters: unknown, _handler: unknown) => {
        captured.push({ name, parameters })
        return { name, parameters }
      },
      createSdkMcpServer: (server: { tools: unknown[] }) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    const servers: Record<string, Record<string, unknown>> = {}

    await injectAgentSkinMcpServer(sdk, servers, {
      workspaceSlug: 'profer',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/session'],
    })

    expect(Object.keys(servers)).toEqual(['agent-skin'])
    expect(captured).toHaveLength(1)
    expect(captured[0]!.name).toBe(AGENT_SKIN_TOOL_NAME)
    expect(JSON.stringify(captured[0]!.parameters)).toContain('skinCss')
    expect(JSON.stringify(captured[0]!.parameters)).toContain('wallpaperPath')
  })

  test('Given a generated wallpaper and complete CSS When create_skin runs Then it stages a valid package and installs it', async () => {
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
    const sdk = {
      tool: (_name: string, _description: string, _parameters: unknown, nextHandler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handler = nextHandler
        return { name: AGENT_SKIN_TOOL_NAME }
      },
      createSdkMcpServer: (server: { tools: unknown[] }) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    const servers: Record<string, Record<string, unknown>> = {}

    await injectAgentSkinMcpServer(sdk, servers, {
      workspaceSlug: 'profer',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/session'],
    })
    const result = await handler!({
      id: 'test-skin',
      name: 'Test skin',
      tone: 'dark',
      skinCss: ':root { --background: #111; }\n.shell-bg { background-image: url("assets/wallpaper.png"); }',
      wallpaperPath: '.context/agent-output-images/generated.png',
      wallpaperFilename: 'wallpaper.png',
    }) as { details?: { applied?: boolean; wallpaper?: string; installedPath?: string; validated?: boolean } }

    // installedPath 必须确定性可见：此前模型拿不到安装位置，会在安装后用 find 一路扫到家目录。
    expect(result.details).toMatchObject({
      applied: true,
      wallpaper: 'assets/wallpaper.png',
      validated: true,
      installedPath: '~/.profer-dev/skins/test-skin',
    })
    expect(stagedPackage?.css).toContain('assets/wallpaper.png')
    expect(JSON.parse(stagedPackage!.manifest)).toMatchObject({ id: 'test-skin', contractVersion: 2 })
    expect(stagedPackage!.wallpaper).toEqual(Buffer.from([0x89, 0x50]))
  })
})

describe('Agent 皮肤工具：Windows 保留设备名拦截', () => {
  async function loadHandler() {
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
    const sdk = {
      tool: (_name: string, _description: string, _parameters: unknown, nextHandler: (args: Record<string, unknown>) => Promise<unknown>) => {
        handler = nextHandler
        return { name: AGENT_SKIN_TOOL_NAME }
      },
      createSdkMcpServer: (server: { tools: unknown[] }) => server,
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    await injectAgentSkinMcpServer(sdk, {}, {
      workspaceSlug: 'profer',
      agentCwd: '/safe/session',
      allowedRoots: ['/safe/session'],
    })
    return handler!
  }

  const base = { name: 'Reserved skin', tone: 'dark', skinCss: ':root { --background: #111; }' }

  test.each(['con', 'nul', 'com1', 'lpt1'])('Given id %s When create_skin runs Then it is rejected before install', async (id) => {
    const handler = await loadHandler()
    const result = await handler({ ...base, id }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Windows 保留设备名')
  })

  test('Given a reserved wallpaper filename When create_skin runs Then it is rejected', async () => {
    const handler = await loadHandler()
    const result = await handler({
      ...base,
      id: 'safe-skin',
      wallpaperPath: '.context/agent-output-images/generated.png',
      wallpaperFilename: 'nul.png',
    }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Windows 保留设备名')
  })
})
