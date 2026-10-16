import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { SDKMessage } from '@profer/shared'
import { AgentMessages } from './AgentMessages'

function user(text: string, uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function assistant(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text: `回复 ${uuid}` }], model: 'deepseek-v4-flash' },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

/** 两轮对话：u1/a1、u2/a2（a2 为最后一轮回复）。 */
function twoTurns(): SDKMessage[] {
  return [user('第一问', 'u1'), assistant('a1'), user('第二问', 'u2'), assistant('a2')]
}

function renderMessages(
  messages: SDKMessage[],
  props: Partial<React.ComponentProps<typeof AgentMessages>> = {},
): string {
  return renderToStaticMarkup(
    React.createElement(
      Provider,
      { store: createStore() },
      React.createElement(AgentMessages, {
        sessionId: 's1',
        messagesLoaded: true,
        persistedSDKMessages: messages,
        streaming: false,
        ...props,
      }),
    ),
  )
}

const countOf = (markup: string, needle: string): number => markup.split(needle).length - 1

describe('AgentMessages「修改重发」入口（任意用户消息，不限于最后一条）', () => {
  test('空闲时每一条用户消息都渲染入口', () => {
    const markup = renderMessages(twoTurns(), { onEditUserMessage: () => {} })

    // 两条用户消息 → 两个入口（历史轮次同样可改，是本次相对「只支持最后一条被停止的消息」的关键变化）
    expect(countOf(markup, '修改重发')).toBe(2)
  })

  test('未传回调时不渲染入口（探索分支等只读场景）', () => {
    expect(countOf(renderMessages(twoTurns()), '修改重发')).toBe(0)
  })

  test('会话活跃（流式）时不暴露入口，避免与运行中的 agent session 冲突', () => {
    const markup = renderMessages(twoTurns(), { onEditUserMessage: () => {}, streaming: true })

    expect(countOf(markup, '修改重发')).toBe(0)
  })

  test('后台任务等待态同样不暴露入口', () => {
    const markup = renderMessages(twoTurns(), {
      onEditUserMessage: () => {},
      streamState: { backgroundWaiting: true } as React.ComponentProps<typeof AgentMessages>['streamState'],
    })

    expect(countOf(markup, '修改重发')).toBe(0)
  })

  test('原地编辑态：只有目标那条消息变成编辑框，其余消息不再提供入口', () => {
    const markup = renderMessages(twoTurns(), {
      onEditUserMessage: () => {},
      onSubmitEditUserMessage: () => {},
      onCancelEditUserMessage: () => {},
      editingUserMessageUuid: 'u1',
    })

    // 编辑框在该条消息里（与 Chat 同一位置：不进底部 composer）
    expect(countOf(markup, '编辑消息...')).toBe(1)
    // 编辑中的这条不再显示入口，另一条（u2）仍在
    expect(countOf(markup, '修改重发')).toBe(1)
  })
})
