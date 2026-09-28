/**
 * Agent Fabric 文件持久化适配
 *
 * 设计文档 §12：任务元数据、状态变化、事件游标与产物索引必须可持久化、可恢复。
 * 采用配置文件风格（JSON/JSONL 文件），不用数据库：
 * - tasks/<taskId>.json    任务实体（含状态，重写式保存）
 * - results/<taskId>.json  结构化结果
 * - artifacts.json         产物索引
 * - request-index.json     requestId -> taskId（跨重启提交幂等）
 * - events/<taskId>.jsonl  事件流（追加式，游标恢复的基础）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import {
  ProtocolError,
  ProtocolErrorCode,
  type AgentTask,
  type AppendEventInput,
  type ArtifactRef,
  type GatewayTaskStore,
  type TaskEvent,
  type TaskEventLog,
  type TaskResult,
} from '@profer/agent-fabric'

export function getFabricDataDir(baseDir?: string): string {
  return join(baseDir ?? getConfigDir(), 'agent-fabric')
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

// ===== 任务 / 结果 / 产物 / 幂等索引 =====

export function createFileTaskStore(baseDir?: string): GatewayTaskStore {
  const dataDir = getFabricDataDir(baseDir)
  const tasksDir = join(dataDir, 'tasks')
  const resultsDir = join(dataDir, 'results')
  const artifactsPath = join(dataDir, 'artifacts.json')
  const requestIndexPath = join(dataDir, 'request-index.json')

  // 内存镜像 + 写穿透：读取走内存（事件订阅高频），写同时落盘。
  const tasks = new Map<string, AgentTask>()
  const results = new Map<string, TaskResult>()
  const artifacts = new Map<string, ArtifactRef>(Object.entries(readJson<Record<string, ArtifactRef>>(artifactsPath) ?? {}))
  const requestIndex = new Map<string, string>(Object.entries(readJson<Record<string, string>>(requestIndexPath) ?? {}))

  if (existsSync(tasksDir)) {
    for (const file of readdirSync(tasksDir)) {
      if (!file.endsWith('.json')) continue
      const task = readJson<AgentTask>(join(tasksDir, file))
      if (task?.request?.taskId) tasks.set(task.request.taskId, task)
    }
  }
  if (existsSync(resultsDir)) {
    for (const file of readdirSync(resultsDir)) {
      if (!file.endsWith('.json')) continue
      const taskId = file.slice(0, -'.json'.length)
      const result = readJson<TaskResult>(join(resultsDir, file))
      if (result) results.set(taskId, result)
    }
  }

  const persistArtifacts = (): void => writeJson(artifactsPath, Object.fromEntries(artifacts))
  const persistRequestIndex = (): void => writeJson(requestIndexPath, Object.fromEntries(requestIndex))

  return {
    save(task) {
      tasks.set(task.request.taskId, task)
      writeJson(join(tasksDir, `${task.request.taskId}.json`), task)
    },
    get: (taskId) => tasks.get(taskId),
    list: () => [...tasks.values()],
    indexRequestId(requestId, taskId) {
      requestIndex.set(requestId, taskId)
      persistRequestIndex()
    },
    findByRequestId(requestId) {
      const taskId = requestIndex.get(requestId)
      return taskId ? tasks.get(taskId) : undefined
    },
    saveResult(taskId, result) {
      results.set(taskId, result)
      writeJson(join(resultsDir, `${taskId}.json`), result)
    },
    getResult: (taskId) => results.get(taskId),
    saveArtifact(ref) {
      artifacts.set(ref.artifactId, ref)
      persistArtifacts()
    },
    getArtifact: (artifactId) => artifacts.get(artifactId),
    listArtifacts: (taskId) => [...artifacts.values()].filter((ref) => ref.taskId === taskId),
  }
}

// ===== 事件日志（JSONL 追加 + 启动回放） =====

export function createFileEventLog(baseDir?: string): TaskEventLog {
  const eventsDir = join(getFabricDataDir(baseDir), 'events')
  const eventsByTask = new Map<string, TaskEvent[]>()
  const seenEventIds = new Map<string, TaskEvent>()
  let restoredMaxSequence = new Map<string, number>()

  if (existsSync(eventsDir)) {
    for (const file of readdirSync(eventsDir)) {
      if (!file.endsWith('.jsonl')) continue
      const taskId = file.slice(0, -'.jsonl'.length)
      const list: TaskEvent[] = []
      for (const line of readFileSync(join(eventsDir, file), 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as TaskEvent
          if (seenEventIds.has(event.eventId)) continue
          seenEventIds.set(event.eventId, event)
          list.push(event)
        } catch {
          // 跳过损坏行，不阻断整体回放
        }
      }
      list.sort((a, b) => a.eventSequence - b.eventSequence)
      eventsByTask.set(taskId, list)
      restoredMaxSequence.set(taskId, list.length > 0 ? (list[list.length - 1]?.eventSequence ?? 0) : 0)
    }
  }

  return {
    append(input: AppendEventInput): TaskEvent {
      const duplicate = seenEventIds.get(input.eventId)
      if (duplicate) return duplicate

      const list = eventsByTask.get(input.taskId) ?? []
      // 序列从回放的最大值继续递增，保证重启后游标语义不被重置。
      const base = restoredMaxSequence.get(input.taskId) ?? 0
      const event: TaskEvent = {
        eventId: input.eventId,
        eventSequence: Math.max(base, list.length > 0 ? (list[list.length - 1]?.eventSequence ?? 0) : 0) + 1,
        taskId: input.taskId,
        type: input.type,
        occurredAt: input.occurredAt,
        producerAgentId: input.producerAgentId,
        payload: input.payload,
      }
      list.push(event)
      eventsByTask.set(input.taskId, list)
      seenEventIds.set(input.eventId, event)

      try {
        mkdirSync(eventsDir, { recursive: true })
        appendFileSync(join(eventsDir, `${input.taskId}.jsonl`), JSON.stringify(event) + '\n', 'utf-8')
      } catch (error) {
        console.error(`[AgentFabric] 事件落盘失败 taskId=${input.taskId}:`, error)
      }
      return event
    },
    resumeAfter(cursor) {
      const list = eventsByTask.get(cursor.taskId) ?? []
      if (cursor.lastEventSequence > (list[list.length - 1]?.eventSequence ?? 0)) {
        throw new ProtocolError(
          ProtocolErrorCode.VALIDATION_FAILED,
          `恢复游标越界：taskId=${cursor.taskId} lastEventSequence=${cursor.lastEventSequence}`,
        )
      }
      return list.filter((event) => event.eventSequence > cursor.lastEventSequence)
    },
    listByTask(taskId) {
      return [...(eventsByTask.get(taskId) ?? [])]
    },
  }
}
