/**
 * agent-navigation-index — 会话「消息导航」的全量轮次索引（主进程只读）。
 *
 * 背景：渲染层只加载会话尾部一页消息（DESKTOP_AGENT_PAGE_SIZE=60），本地还会再切一刀
 * 渲染窗口（HISTORY_GROUP_PAGE_SIZE=30）。所以渲染层手里的分组天然只是「已加载的尾巴」，
 * 用它当导航总数，就会出现「会话越长、总数越少」——翻页/折叠看起来像在改计数。
 *
 * 产出给渲染层的是一份紧凑的**全量轮次索引**：一轮一行，只带滚动锚点 id / 角色 / 预览 / 模型。
 *
 * 实现（与文档保持一致）：走渲染层读消息同一条 shared 读取路径（`getAgentSessionSDKMessages`），
 * 因此「哪些行算消息」「已恢复的瞬时断流要不要丢」与渲染层完全一致，不会出现两侧行数不同。
 * 首次请求按文件 (size, mtimeMs) 建立索引并缓存；同一版本重复请求不重算。
 *
 * 代价：首次建立索引要把会话完整读一遍（与 fork / 回溯 / rewind 已用同一路径，内存曲线相同）。
 * 大会话上这是一次性成本，不做逐行流式改写，避免两套解析器随时间漂移。
 */

import { statSync } from 'node:fs'
import { buildNavigationEntries, type NavigationEntry } from '@profer/session-core'
import { getAgentSessionMessagesPath } from './config-paths'
import { getAgentSessionSDKMessages } from './agent-session-manager'

/**
 * 导航索引条目：与 session-core 的 NavigationEntry 同构（已含 id / 回退键），
 * 这里只作为主进程对外类型别名。
 */
export type NavigationIndexEntry = NavigationEntry

export interface NavigationIndex {
  /** 全会话轮次索引，按时间顺序（最早在前） */
  entries: NavigationIndexEntry[]
  /** 全会话轮次总数（= entries.length；单独给出便于渲染层直接展示） */
  total: number
  /** 该索引构建自的文件版本；文件被外部改写会导致变化 */
  revision: string
}

interface CacheEntry {
  revision: string
  index: NavigationIndex
}

/** 每个会话只保留最近一次索引结果；磁盘版本未变时直接复用。 */
const cache = new Map<string, CacheEntry>()

function fileRevision(path: string): string | null {
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * 读取单个会话的全量导航索引。
 *
 * 会话不存在或读取失败时返回空索引（导航整体隐藏），不抛错——会话文件可能正被写入或已被删除。
 * 结果按 (size, mtimeMs) 缓存；只有文件确实变化才重新解析。
 */
export function getAgentSessionNavigationIndex(sessionId: string): NavigationIndex {
  const path = getAgentSessionMessagesPath(sessionId)
  const revision = fileRevision(path)
  if (revision === null) {
    return { entries: [], total: 0, revision: 'missing' }
  }

  const cached = cache.get(sessionId)
  if (cached && cached.revision === revision) return cached.index

  const index = buildIndex(sessionId, revision)
  cache.set(sessionId, { revision, index })
  return index
}

/** 显式失效（会话被删除/清空时调用，避免占用内存）。 */
export function invalidateAgentSessionNavigationIndex(sessionId: string): void {
  cache.delete(sessionId)
}

/** 供测试或“整理会话”场景整体清空。 */
export function clearAgentSessionNavigationIndexCache(): void {
  cache.clear()
}

function buildIndex(sessionId: string, revision: string): NavigationIndex {
  let entries: NavigationEntry[]
  try {
    // 与渲染层读消息走同一条路径（含损坏行跳过与「已恢复的瞬时断流」清理），
    // 保证两侧对「有哪些分组」的判断一致。
    entries = buildNavigationEntries(getAgentSessionSDKMessages(sessionId))
  } catch {
    return { entries: [], total: 0, revision }
  }
  return { entries, total: entries.length, revision }
}
