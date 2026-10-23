/**
 * TabContent — 标签内容渲染器
 *
 * 根据标签类型渲染参数化的 ChatView 或 AgentView。
 * 直接传递 sessionId/conversationId prop，无需桥接全局 atoms。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { tabsAtom } from '@/atoms/tab-atoms'
import { markdownTocOpenAtom } from '@/atoms/markdown-toc'
import { ChatView } from '@/components/chat'
import { AgentView } from '@/components/agent'
import { PreviewTabContent } from '@/components/diff/PreviewTabContent'
import { BrowserTabContent } from '@/components/browser/BrowserTabContent'
import { MarkdownRichEditor } from '@/components/diff/MarkdownRichEditor'
import { MarkdownToc } from '@/components/diff/MarkdownToc'
import { ScratchPadView } from '@/components/scratch-pad/ScratchPadView'
import { TabErrorBoundary } from './TabErrorBoundary'
import { PluginViewport } from './PluginViewport'

const TAB_VIEW_INSTANCE = { kind: 'tab' as const }

export interface TabContentProps {
  tabId: string
}

export function TabContent({ tabId }: TabContentProps): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const tab = tabs.find((t) => t.id === tabId)

  // [FLASH-DEBUG] 监控 tab 查找失败（说明 tabId 指向了不存在的标签）
  React.useEffect(() => {
    if (!tab) {
      console.warn(`[FLASH-DEBUG] TabContent: tab not found for tabId="${tabId}"`, { tabIds: tabs.map(t => t.id) })
    }
  }, [tab, tabId, tabs])

  if (!tab) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        标签页不存在
      </div>
    )
  }

  if (tab.type === 'scratch') {
    return <ScratchPadView />
  }

  if (tab.type === 'tutorial') {
    return <MarkdownDocTab load={loadTutorialContent} errorText="教程加载失败" docClassName="tutorial-doc" />
  }

  if (tab.type === 'frp-guide') {
    return <MarkdownDocTab load={loadFrpGuideContent} errorText="教程加载失败" />
  }

  if (tab.type === 'chat') {
    return (
      <TabErrorBoundary key={tab.sessionId} sessionId={tab.sessionId}>
        <ChatView conversationId={tab.sessionId} />
      </TabErrorBoundary>
    )
  }

  if (tab.type === 'preview') {
    return (
      <TabErrorBoundary key={tab.id} sessionId={tab.sessionId}>
        <PreviewTabContent tabId={tab.id} sessionId={tab.sessionId} filePath={tab.filePath ?? ''} />
      </TabErrorBoundary>
    )
  }

  if (tab.type === 'browser') {
    return (
      <TabErrorBoundary key={tab.id} sessionId={tab.sessionId}>
        <BrowserTabContent tabId={tab.id} sessionId={tab.sessionId} browserTabId={tab.browserTabId ?? ''} />
      </TabErrorBoundary>
    )
  }

  if (tab.type === 'plugin' && tab.pluginId && tab.pluginPageId) {
    return <PluginViewport pluginId={tab.pluginId} pageId={tab.pluginPageId} instance={tab.pluginScope === 'session' ? { kind: 'tab', sessionId: tab.sessionId } : TAB_VIEW_INSTANCE} visible />
  }

  return (
    <TabErrorBoundary key={tab.sessionId} sessionId={tab.sessionId}>
      <AgentView sessionId={tab.sessionId} />
    </TabErrorBoundary>
  )
}

const loadTutorialContent = (): Promise<string | null> => window.electronAPI.getTutorialContent()
const loadFrpGuideContent = (): Promise<string | null> => window.electronAPI.getFrpGuideContent()

/** 单例 markdown 文档 Tab（教程 / 自建 FRP 教程）共用的只读渲染器。 */
function MarkdownDocTab({ load, errorText, docClassName }: { load: () => Promise<string | null>; errorText: string; docClassName?: string }): React.ReactElement {
  const [content, setContent] = React.useState('')
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const tocOpen = useAtomValue(markdownTocOpenAtom)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    load()
      .then((result) => {
        if (result === null) {
          setLoadState('error')
          return
        }
        setContent(result)
        setLoadState('ready')
      })
      .catch((error) => {
        console.error(error)
        setLoadState('error')
      })
  }, [load])

  if (loadState === 'loading') {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中...</div>
  }

  if (loadState === 'error') {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{errorText}</div>
  }

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <MarkdownToc containerRef={scrollRef as React.RefObject<HTMLElement>} contentKey={content.slice(0, 100)} enabled={tocOpen} />
      <div ref={scrollRef} className={docClassName ? 'flex-1 min-w-0 overflow-y-auto px-8 py-12' : 'flex-1 min-w-0 overflow-y-auto p-8'}>
        <div className={docClassName}>
          <MarkdownRichEditor
            value={content}
            editing={false}
            onChange={() => {}}
            onSave={() => {}}
            onCancel={() => {}}
          />
        </div>
      </div>
    </div>
  )
}
