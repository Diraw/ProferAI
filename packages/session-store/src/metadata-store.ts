import { randomUUID } from 'node:crypto'
import { normalizeAgentRuntime, type AgentRuntime, type AgentSessionMeta } from '@profer/shared'
import type { AgentSessionsIndex, SessionMetadataStore, SessionIndexStore } from './contracts'

export interface SessionMetadataStoreOptions {
  index: SessionIndexStore
}

export function createSessionMetadataStore(options: SessionMetadataStoreOptions): SessionMetadataStore {
  let mutationTail: Promise<unknown> = Promise.resolve()

  const mutate = <T>(operation: (index: AgentSessionsIndex) => T | Promise<T>): Promise<T> => {
    const next = mutationTail.then(async () => {
      const index = await options.index.read()
      const result = await operation(index)
      await options.index.write(index)
      return result
    })
    mutationTail = next.catch(() => {})
    return next
  }

  return {
    create: (input) => mutate((index) => {
      const now = Date.now()
      const meta: AgentSessionMeta = {
        id: randomUUID(),
        title: input.title,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        agentRuntime: normalizeAgentRuntime(input.agentRuntime),
        agentRuntimeLocked: false,
        ...(input.draft ? { draft: true } : {}),
        createdAt: now,
        updatedAt: now,
      }
      index.sessions.push(meta)
      return meta
    }),

    update: (sessionId, patch) => mutate((index) => {
      const item = index.sessions.find((session) => session.id === sessionId)
      if (!item) throw new Error(`Agent 会话不存在: ${sessionId}`)
      const updated: AgentSessionMeta = {
        ...item,
        ...patch,
        agentRuntime: patch.agentRuntime === undefined
          ? normalizeAgentRuntime(item.agentRuntime)
          : normalizeAgentRuntime(patch.agentRuntime),
        revision: (item.revision ?? 0) + 1,
        updatedAt: Date.now(),
      }
      Object.assign(item, updated)
      return updated
    }),

    restore: (meta) => mutate((index) => {
      const existing = index.sessions.find((session) => session.id === meta.id)
      if (existing) Object.assign(existing, meta)
      else index.sessions.push(meta)
      return meta
    }),

    remove: (sessionId) => mutate((index) => {
      const indexOfSession = index.sessions.findIndex((session) => session.id === sessionId)
      if (indexOfSession < 0) return undefined
      return index.sessions.splice(indexOfSession, 1)[0]
    }),
  }
}

export type { AgentRuntime }
