import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntime,
  AgentRuntimeCapabilities,
  SDKMessage,
} from '@profer/shared'
import type { AgentRuntimeAdapter, AgentRuntimeQuery } from './contract'
import type { AgentRunOutcome } from './events'

export interface AgentRuntimeProviderAdapterOptions {
  mapInput?: (input: AgentRuntimeQuery, base: AgentQueryInput & { prepared?: AgentRuntimeQuery['prepared'] }) => AgentQueryInput
}

function toProviderInput(input: AgentRuntimeQuery): AgentQueryInput & { prepared?: AgentRuntimeQuery['prepared'] } {
  const providerInput = input.providerInput
  const extra = providerInput && typeof providerInput === 'object' ? providerInput as Readonly<Record<string, unknown>> : undefined
  return {
    ...(extra ?? {}),
    sessionId: input.sessionId,
    prompt: input.prompt,
    ...(input.modelId ? { model: input.modelId } : {}),
    agentRuntime: input.runtime,
    ...(input.isolatedRuntimeSession !== undefined ? { isolatedRuntimeSession: input.isolatedRuntimeSession } : {}),
    ...(input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.prepared ? { prepared: input.prepared } : {}),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 将 shared provider async iterable 适配为 runtime adapter。
 * provider 的进程、权限和 SDK 仍由宿主实现；runtime 只统一 stream/stop/dispose 边界。
 */
export function createAgentRuntimeProviderAdapter(
  runtime: AgentRuntime,
  provider: AgentProviderAdapter,
  options: AgentRuntimeProviderAdapterOptions = {},
): AgentRuntimeAdapter {
  const activeSessionIds = new Set<string>()
  const removeSession = (sessionId: string) => activeSessionIds.delete(sessionId)
  const adapter: AgentRuntimeAdapter = {
    runtime,
    stream(input: AgentRuntimeQuery): AsyncIterable<SDKMessage> {
      activeSessionIds.add(input.sessionId)
      const base = toProviderInput(input)
      const source = provider.query(options.mapInput?.(input, base) ?? base)
      return (async function* () {
        try {
          yield* source
        } finally {
          removeSession(input.sessionId)
        }
      })()
    },
    async query(input, callbacks): Promise<AgentRunOutcome> {
      try {
        for await (const message of provider.query(options.mapInput?.(input, toProviderInput(input)) ?? toProviderInput(input))) {
          await callbacks.onMessage?.(message)
        }
        return { status: 'completed' }
      } catch (error) {
        await callbacks.onError?.(error)
        return { status: 'failed', error: errorMessage(error) }
      }
    },
    stop(_reason, sessionId) {
      if (sessionId) {
        if (activeSessionIds.has(sessionId)) provider.abort(sessionId)
        return
      }
      for (const activeSessionId of activeSessionIds) provider.abort(activeSessionId)
    },
    dispose() {
      provider.dispose()
    },
    getCapabilities(): AgentRuntimeCapabilities {
      const capabilities = provider.getCapabilities?.() ?? {
        supportsTaskOutput: Boolean(provider.getTaskOutput),
        supportsTaskStop: Boolean(provider.stopTask),
        supportsRewind: runtime === 'claude',
        supportsInterrupt: Boolean(provider.interruptQuery),
        supportsQueuedMessage: Boolean(provider.sendQueuedMessage),
        supportsBackgroundWakeup: runtime === 'claude',
        supportsNativeMcp: runtime === 'claude',
        runtimeSupportsSubagents: true,
      }
      return { runtime, available: true, ...capabilities }
    },
  }
  return adapter
}

export type { AgentProviderAdapter }
