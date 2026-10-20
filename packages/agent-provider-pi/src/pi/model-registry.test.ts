import { describe, expect, test } from 'bun:test'
import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent'
import type { XaiOAuthCredentials } from '@profer/shared'
import { buildModel, buildXaiOAuthModel, buildCodexModel, getCodexCatalogModels } from './model-registry'

function fakeSdk() {
  const configurations: CreateModelRuntimeOptions[] = []
  const models: Array<Record<string, unknown>> = []
  const sdk = { ModelRuntime: { create: async (options: CreateModelRuntimeOptions) => {
    configurations.push(options)
    return {
      setRuntimeApiKey: async () => {},
      registerProvider: (_id: string, config: { models: Array<Record<string, unknown>> }) => models.push(...config.models),
      getModel: () => models.at(-1) ?? { id: 'fixture', contextWindow: 200_000 },
      getModels: () => models,
    }
  } } } as unknown as Parameters<typeof buildModel>[0]
  return { sdk, configurations, models }
}

const credentials: XaiOAuthCredentials = { access: 'fixture-access', refresh: 'fixture-refresh', expires: 100 }

describe('Pi model registry host boundaries', () => {
  test('Given an official policy injected by a host When registering a model Then policy controls the verified window', async () => {
    const official = fakeSdk()
    const input = { sessionId: 'fixture', apiKey: 'fixture-key', provider: 'openai' as const, channelId: 'channel', model: 'gpt-5.6-sol', baseUrl: 'https://fixture.invalid/v1' }
    const checks: string[] = []
    await buildModel(official.sdk, input, { isOfficialManagedChannel: (channel) => { checks.push(channel.id); return true } })
    expect(official.models[0]?.contextWindow).toBe(1_050_000)
    expect(checks).toContain('channel')
    const custom = fakeSdk()
    await buildModel(custom.sdk, input, { isOfficialManagedChannel: () => false })
    expect(custom.models[0]?.contextWindow).toBe(272_000)
    expect(official.configurations[0]).toMatchObject({ modelsPath: null, allowModelNetwork: false })
  })

  test('Given xAI credentials When runtime refreshes Then the host coordinator supplies latest tokens and the callback receives the refresh', async () => {
    const fixture = fakeSdk()
    const latest = { ...credentials, access: 'latest-access' }
    const refreshed = { access: 'new-access', refresh: 'new-refresh', expires: 200 }
    const remembered: string[] = []
    const persisted: XaiOAuthCredentials[] = []
    await buildXaiOAuthModel(fixture.sdk, { channelId: 'channel', model: 'fixture', xaiOAuthCredentials: credentials, onXaiOAuthCredentialsRefreshed: (value) => { persisted.push(value) } }, {
      rememberXaiOAuthCredentials: (channelId, value) => { remembered.push(channelId); expect(value).toBe(credentials); return latest },
      refreshXaiOAuthCredentialsSerial: async (channelId, fallback, refresh) => {
        expect(channelId).toBe('channel')
        expect(fallback.access).toBe(latest.access)
        return refresh(latest)
      },
    })
    const store = fixture.configurations[0]!.credentials!
    await expect(store.modify('xai', async (current) => {
      expect(current).toMatchObject({ type: 'oauth', access: 'latest-access' })
      return { type: 'oauth', ...refreshed }
    })).resolves.toMatchObject(refreshed)
    expect(remembered).toEqual(['channel'])
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject(refreshed)
    await expect(store.read('unrelated')).resolves.toBeUndefined()
  })

  test('Given no xAI credential coordinator When OAuth is requested Then runtime rejects before creating a model runtime', async () => {
    const fixture = fakeSdk()
    await expect(buildXaiOAuthModel(fixture.sdk, { channelId: 'channel', xaiOAuthCredentials: credentials })).rejects.toThrow('宿主凭据协调端口')
    expect(fixture.configurations).toHaveLength(0)
  })

  test('Given Codex credentials When SDK replaces them Then refresh metadata reaches the callback and model selection is preserved', async () => {
    const fixture = fakeSdk()
    const model = (await getCodexCatalogModels())[0]!.id
    const updated: unknown[] = []
    await buildCodexModel(fixture.sdk, { model, codexOAuthCredentials: { ...credentials, accountId: 'account' }, onCodexOAuthCredentialsRefreshed: value => { updated.push(value) } })
    const store = fixture.configurations[0]!.credentials!
    await store.modify('openai-codex', async current => ({ ...current!, type: 'oauth', ...credentials, access: 'refreshed-access', accountId: 'account' }))
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ access: 'refreshed-access', accountId: 'account' })
  })

  test('Given Google 渠道只填域名或误填 /v1 When 注册 Pi 模型 Then baseUrl 补齐原生 /v1beta', async () => {
    for (const [baseUrl, expected] of [
      ['https://fixture.invalid', 'https://fixture.invalid/v1beta'],
      ['https://fixture.invalid/v1', 'https://fixture.invalid/v1beta'],
      ['https://fixture.invalid/v1beta/', 'https://fixture.invalid/v1beta'],
      ['https://fixture.invalid/v1beta/models', 'https://fixture.invalid/v1beta'],
    ] as const) {
      const fixture = fakeSdk()
      await buildModel(fixture.sdk, { sessionId: 'fixture', apiKey: 'fixture-key', provider: 'google', channelId: 'channel', model: 'gemini-3.7-flash', baseUrl })
      expect(fixture.models[0]?.baseUrl).toBe(expected)
      expect(fixture.models[0]?.api).toBe('google-generative-ai')
    }
  })
})
