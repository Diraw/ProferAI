/**
 * session-tree.test.ts — 委派会话树状态聚合测试
 *
 * 核心关注：父会话的 completed（绿色）标记只反映父会话自身的未查看完成，
 * 不被子代理"已完成未查看"状态传染。
 */

import { describe, expect, test } from 'bun:test'
import {
  buildAgentSessionTrees,
  collectDelegatedDeletionSessionIds,
  getDelegatedChildStatus,
  getRelatedSessionSummary,
  getSessionTreeStatus,
  hasPinnedVisibleParent,
  type AgentSessionTreeItem,
} from './session-tree'
import type { AgentSessionMeta } from '@profer/shared'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'

const NOW = 1_752_000_000_000

function makeSession(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: `session-${Math.random()}`,
    title: '会话',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeItem(parentId: string, childIds: string[]): AgentSessionTreeItem {
  return {
    session: makeSession({ id: parentId, title: '父会话' }),
    childSessions: childIds.map((id) => makeSession({
      id,
      title: '子会话',
      parentSessionId: parentId,
      sourceDelegationId: 'deleg-1',
    })),
  }
}

function makeMap(entries: Record<string, SessionIndicatorStatus>): Map<string, SessionIndicatorStatus> {
  return new Map(Object.entries(entries))
}

describe('buildAgentSessionTrees — 关联血缘', () => {
  test('Given 主会话和探索分支 When 构建会话树 Then 探索分支挂在主会话下而不是重复显示为根', () => {
    const sessions = [
      makeSession({ id: 'parent', workspaceId: 'workspace-1' }),
      makeSession({
        id: 'exploration',
        workspaceId: 'workspace-1',
        explorationParentSessionId: 'parent',
        explorationSourceMessageId: 'assistant-message',
      }),
      makeSession({ id: 'ordinary', workspaceId: 'workspace-1' }),
    ]

    const trees = buildAgentSessionTrees(sessions)

    expect(trees.map((item) => item.session.id)).toEqual(['parent', 'ordinary'])
    expect(trees[0]?.childSessions.map((session) => session.id)).toEqual(['exploration'])
  })

  test('Given 父子会话 workspaceId 不一致 When 构建会话树 Then 保持探索分支为根避免跨项目串线', () => {
    const sessions = [
      makeSession({ id: 'parent', workspaceId: 'workspace-1' }),
      makeSession({
        id: 'exploration',
        workspaceId: 'workspace-2',
        explorationParentSessionId: 'parent',
        explorationSourceMessageId: 'assistant-message',
      }),
    ]

    const trees = buildAgentSessionTrees(sessions)

    expect(trees.map((item) => item.session.id)).toEqual(['parent', 'exploration'])
    expect(trees[0]?.childSessions).toEqual([])
  })
})

describe('collectDelegatedDeletionSessionIds', () => {
  test('Given 嵌套委派子会话和普通会话 When 收集删除范围 Then 仅包含根与所有委派后代', () => {
    const sessions = [
      makeSession({ id: 'parent' }),
      makeSession({ id: 'child', parentSessionId: 'parent', sourceDelegationId: 'd-child' }),
      makeSession({ id: 'grandchild', parentSessionId: 'child', sourceDelegationId: 'd-grandchild' }),
      makeSession({ id: 'ordinary', parentSessionId: 'parent' }),
      makeSession({ id: 'unrelated', parentSessionId: 'other', sourceDelegationId: 'd-other' }),
      makeSession({
        id: 'exploration',
        explorationParentSessionId: 'parent',
        explorationSourceMessageId: 'assistant-message',
      }),
    ]

    expect(collectDelegatedDeletionSessionIds(sessions, 'parent')).toEqual(new Set(['parent', 'child', 'grandchild']))
  })
})

describe('getRelatedSessionSummary — 父行展开信息', () => {
  test('Given 仅委派子会话 When 汇总 Then 显示计数且标签为子会话', () => {
    const children = [
      makeSession({ id: 'd1', parentSessionId: 'parent', sourceDelegationId: 'delegation-1', delegationStatus: 'running' }),
      makeSession({ id: 'd2', parentSessionId: 'parent', sourceDelegationId: 'delegation-2', delegationStatus: 'completed' }),
    ]

    expect(getRelatedSessionSummary(children)).toEqual({
      total: 2,
      running: 1,
      completed: 1,
      label: '子会话',
      showCount: true,
    })
  })

  test('Given 仅探索分支 When 汇总 Then 不显示计数且标签为探索分支', () => {
    const children = [
      makeSession({ id: 'e1', explorationParentSessionId: 'parent', explorationSourceMessageId: 'assistant-1' }),
    ]

    // 探索分支不参与 x/y 计数：父行右侧空间要留给时间/置顶/归档/菜单
    expect(getRelatedSessionSummary(children)).toEqual({
      total: 1,
      running: 0,
      completed: 0,
      label: '探索分支',
      showCount: false,
    })
  })

  test('Given 委派与探索混合存在 When 汇总 Then 不显示计数且标签为关联会话', () => {
    const children = [
      makeSession({ id: 'd1', parentSessionId: 'parent', sourceDelegationId: 'delegation-1', delegationStatus: 'completed' }),
      makeSession({ id: 'e1', explorationParentSessionId: 'parent', explorationSourceMessageId: 'assistant-1' }),
    ]

    expect(getRelatedSessionSummary(children)).toEqual({
      total: 2,
      running: 0,
      completed: 1,
      label: '关联会话',
      showCount: false,
    })
  })
})

describe('hasPinnedVisibleParent — 探索分支可见性', () => {
  test('Given 探索分支的主会话已置顶 When 判断侧栏归属 Then 分支收纳到置顶主会话下', () => {
    const parent = makeSession({ id: 'parent', workspaceId: 'workspace-1', pinned: true })
    const exploration = makeSession({
      id: 'exploration',
      workspaceId: 'workspace-1',
      explorationParentSessionId: 'parent',
      explorationSourceMessageId: 'assistant-message',
    })

    expect(hasPinnedVisibleParent(exploration, [parent, exploration])).toBe(true)
  })
})

describe('getSessionTreeStatus — 父会话状态聚合', () => {
  test('Given 父会话 idle 且子代理完成后未查看 When 聚合状态 Then 父会话为 idle（不显示绿色完成标记）', () => {
    const item = makeItem('parent-1', ['child-1'])
    const map = makeMap({ 'child-1': 'completed' })

    expect(getSessionTreeStatus(item, map)).toBe('idle')
  })

  test('Given 父会话 idle 且子代理正在运行 When 聚合状态 Then 父会话为 running（子代理活动需体现）', () => {
    const item = makeItem('parent-2', ['child-2'])
    const map = makeMap({ 'child-2': 'running' })

    expect(getSessionTreeStatus(item, map)).toBe('running')
  })

  test('Given 父会话 idle 且子代理被阻塞 When 聚合状态 Then 父会话为 blocked', () => {
    const item = makeItem('parent-3', ['child-3'])
    const map = makeMap({ 'child-3': 'blocked' })

    expect(getSessionTreeStatus(item, map)).toBe('blocked')
  })

  test('Given 父会话自身已完成未查看 When 聚合状态 Then 父会话保持 completed（不因无子代理活动而丢失）', () => {
    const item = makeItem('parent-4', ['child-4'])
    const map = makeMap({ 'parent-4': 'completed' })

    expect(getSessionTreeStatus(item, map)).toBe('completed')
  })

  test('Given 父会话 completed 且子代理 running When 聚合状态 Then 按优先级返回 running', () => {
    const item = makeItem('parent-5', ['child-5'])
    const map = makeMap({ 'parent-5': 'completed', 'child-5': 'running' })

    expect(getSessionTreeStatus(item, map)).toBe('running')
  })

  test('Given 父会话 idle 且无子会话 When 聚合状态 Then 父会话为 idle', () => {
    const item = makeItem('parent-6', [])

    expect(getSessionTreeStatus(item, new Map())).toBe('idle')
  })

  test('Given 子代理运行中但无实时指示器（delegationStatus 持久化为 running）When 聚合状态 Then 子会话为 running 并向上聚合', () => {
    const child = makeSession({
      id: 'child-7',
      title: '子会话',
      parentSessionId: 'parent-7',
      sourceDelegationId: 'deleg-7',
      delegationStatus: 'running',
    })
    const item: AgentSessionTreeItem = {
      session: makeSession({ id: 'parent-7', title: '父会话' }),
      childSessions: [child],
    }

    expect(getDelegatedChildStatus(child, new Map())).toBe('running')
    expect(getSessionTreeStatus(item, new Map())).toBe('running')
  })
})
