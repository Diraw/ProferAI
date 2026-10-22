import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import type { RuntimeStatus } from '@profer/shared'
import { buildAgentSdkEnv } from './agent-sdk-env'
import { createElectronProviderQueryPreparation } from './agent-runtime-provider-preparation'
import type { AgentRuntimeEnv } from './agent-runtime-env'

/**
 * 完整 Claude SDK env 的平台 fixture。
 *
 * 当前宿主是 macOS，但 Windows 的 Git Bash / WSL 语义必须在任意宿主上可验证，
 * 因此 platform / runtimeStatus / shellPreference / proxyUrl 全部以参数注入。
 */

function winRuntimeStatus(gitBashPath: string | null, wslAvailable = false): RuntimeStatus {
  return {
    node: { available: false, path: null, version: null, error: null },
    bun: { available: false, path: null, version: null, source: null, error: null },
    git: { available: false, path: null, version: null, error: null },
    shell: {
      gitBash: { available: gitBashPath !== null, path: gitBashPath, version: null, error: null },
      wsl: { available: wslAvailable, version: 2, defaultDistro: wslAvailable ? 'Ubuntu' : null, distros: [], error: null },
      recommended: gitBashPath ? 'git-bash' : wslAvailable ? 'wsl' : null,
    },
    envLoaded: true,
    initializedAt: 1,
  }
}

const credentials = {
  apiKey: 'session-only-secret',
  baseUrl: 'https://gateway.example/v1',
  provider: 'anthropic' as const,
  forceBearerAuth: false,
}

const baseOptions = {
  proxyUrl: 'http://127.0.0.1:7890',
  platform: 'darwin' as NodeJS.Platform,
  processEnv: { PATH: '/usr/bin:/bin', HOME: '/Users/mac' } as NodeJS.ProcessEnv,
  bundledCliPath: '/Applications/Profer.app/Contents/Resources/bin/profer',
  sdkConfigDir: '/Users/mac/.profer-dev/sdk-config',
}

describe('buildAgentSdkEnv 平台语义', () => {
  test('Given macOS When 构造 SDK env Then 代理 / 配置隔离 / 随包 CLI / 基线 PATH 都在，且不注入 Windows shell', async () => {
    const env = await buildAgentSdkEnv(credentials, baseOptions)

    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/mac')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/mac/.profer-dev/sdk-config')
    expect(env.PROFER_CLI).toBe('/Applications/Profer.app/Contents/Resources/bin/profer')
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000')
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('true')
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    // Windows 专属：非 win32 不得出现，避免误导 SDK 的 shell 选择。
    expect(env.CLAUDE_CODE_SHELL).toBeUndefined()
    expect(env.CLAUDE_BASH_NO_LOGIN).toBeUndefined()
  })

  test('Given Linux When 构造 SDK env Then 与 macOS 同形（不注入 Windows shell）', async () => {
    const env = await buildAgentSdkEnv(credentials, { ...baseOptions, platform: 'linux' })
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/mac/.profer-dev/sdk-config')
    expect(env.CLAUDE_CODE_SHELL).toBeUndefined()
    expect(env.CLAUDE_BASH_NO_LOGIN).toBeUndefined()
  })

  test('Given Windows + Git Bash 可用 + auto Then CLAUDE_CODE_SHELL 指向 Git Bash 且禁用 login shell', async () => {
    const env = await buildAgentSdkEnv(credentials, {
      ...baseOptions,
      platform: 'win32',
      processEnv: { Path: 'C:\\Windows\\System32' },
      runtimeStatus: winRuntimeStatus('C:\\Program Files\\Git\\bin\\bash.exe'),
      shellPreference: 'auto',
    })

    expect(env.CLAUDE_CODE_SHELL).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(env.CLAUDE_BASH_NO_LOGIN).toBe('1')
  })

  test('Given Windows + 用户偏好 WSL Then CLAUDE_CODE_SHELL=wsl（保持旧链字面量）', async () => {
    const env = await buildAgentSdkEnv(credentials, {
      ...baseOptions,
      platform: 'win32',
      processEnv: { Path: 'C:\\Windows\\System32' },
      runtimeStatus: winRuntimeStatus('C:\\Program Files\\Git\\bin\\bash.exe', true),
      shellPreference: 'wsl',
    })

    expect(env.CLAUDE_CODE_SHELL).toBe('wsl')
    expect(env.CLAUDE_BASH_NO_LOGIN).toBe('1')
  })

  test('Given Windows 但没有任何可用 shell Then 不伪造 CLAUDE_CODE_SHELL（保留缺失语义）', async () => {
    const env = await buildAgentSdkEnv(credentials, {
      ...baseOptions,
      platform: 'win32',
      processEnv: { Path: 'C:\\Windows\\System32' },
      runtimeStatus: winRuntimeStatus(null),
      shellPreference: 'auto',
    })

    expect(env.CLAUDE_CODE_SHELL).toBeUndefined()
    expect(env.CLAUDE_BASH_NO_LOGIN).toBe('1')
  })

  test('Given 环境里已有旧认证 / 旧端点 When 构造 SDK env Then 本轮凭证覆盖旧值且未管理的 ANTHROPIC_* 被清空', async () => {
    const processEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'stale-key',
      ANTHROPIC_BASE_URL: 'https://stale.example',
      ANTHROPIC_AUTH_TOKEN: 'stale-token',
      ANTHROPIC_MODEL: 'stale-model',
      ANTHROPIC_CUSTOM_HEADERS: 'User-Agent: stale',
    }
    const env = await buildAgentSdkEnv(credentials, { ...baseOptions, processEnv, platform: 'darwin' })

    expect(env.ANTHROPIC_API_KEY).toBe('session-only-secret')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
    expect(env.ANTHROPIC_MODEL).toBe('')
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('')
    // 只写 env 副本，绝不回写主进程。
    expect(processEnv.ANTHROPIC_API_KEY).toBe('stale-key')
    expect(processEnv.ANTHROPIC_BASE_URL).toBe('https://stale.example')
  })

  test('Given Bearer 计划渠道 When 构造 SDK env Then 使用 ANTHROPIC_AUTH_TOKEN 且不带旧 API Key', async () => {
    const env = await buildAgentSdkEnv({ ...credentials, provider: 'kimi-coding' }, { ...baseOptions, platform: 'darwin' })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('session-only-secret')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('User-Agent:')
  })

  test('Given 开发模式无随包 CLI When 构造 SDK env Then 不注入 PROFER_CLI（skill 回退源码运行）', async () => {
    const env = await buildAgentSdkEnv(credentials, { ...baseOptions, platform: 'darwin', bundledCliPath: undefined, processEnv: {} })
    expect('PROFER_CLI' in env).toBe(false)
  })

  test('Given 无代理 When 构造 SDK env Then 不写代理变量', async () => {
    const env = await buildAgentSdkEnv(credentials, { ...baseOptions, platform: 'darwin', proxyUrl: '' })
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
  })
})

describe('新链 provider preparation 的 env 传递', () => {
  test('Given Claude runtime When provider preparation Then env 含完整 SDK 环境而不是只有认证变量', async () => {
    const preparation = createElectronProviderQueryPreparation()
    const options = await preparation.prepare(
      { sessionId: 'session-1', prompt: 'hello', runtime: 'claude', cwd: '/tmp/workspace' },
      { credentials },
      new AbortController().signal,
    ) as Record<string, unknown>

    const env = options.env as Record<string, string | undefined>
    expect(env.ANTHROPIC_API_KEY).toBe('session-only-secret')
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy()
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000')
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('true')
    expect(typeof env.PATH).toBe('string')
    expect(options.sdkCliPath).toBeTruthy()
  })

  test('Given Pi runtime When provider preparation Then runtimeEnv 经宿主解析后传给 provider（同源实现）', async () => {
    const fixture: AgentRuntimeEnv = {
      env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:7890' },
      shellKind: 'posix',
      shellPath: '/bin/bash',
    }
    const calls: Array<{ sessionId: string; cwd: string }> = []
    const preparation = createElectronProviderQueryPreparation({
      resolveRuntimeEnv: async (input) => {
        calls.push({ sessionId: input.sessionId, cwd: input.cwd })
        return { ...fixture, env: { ...fixture.env } }
      },
    })
    const options = await preparation.prepare(
      { sessionId: 'session-1', prompt: 'hello', runtime: 'pi', cwd: '/tmp/workspace' },
      { credentials },
      new AbortController().signal,
    ) as Record<string, unknown>

    expect(calls).toEqual([{ sessionId: 'session-1', cwd: '/tmp/workspace' }])
    expect(options.runtimeEnv).toEqual(fixture)
    expect(options.cwd).toBe('/tmp/workspace')
  })

  test('Given Pi runtime 没有 cwd When provider preparation Then 用用户主目录而不是 process.cwd()', async () => {
    const calls: Array<string> = []
    const preparation = createElectronProviderQueryPreparation({
      resolveRuntimeEnv: async (input) => {
        calls.push(input.cwd)
        return { env: {}, shellKind: 'posix' }
      },
    })
    await preparation.prepare(
      { sessionId: 'session-1', prompt: 'hello', runtime: 'pi' },
      { credentials },
      new AbortController().signal,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(homedir())
    expect(calls[0]).not.toBe(process.cwd())
  })
})
