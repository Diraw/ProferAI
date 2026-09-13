import { useStore } from 'jotai'
import type { ProferPluginTaskReference } from '@profer/plugin-api'
import { openPluginTab, tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { appModeAtom } from '@/atoms/app-mode'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import { currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'

export function usePluginPage(): (pluginId: string, pageId: string, title: string, reference?: ProferPluginTaskReference) => Promise<void> {
  const store = useStore()
  return async (pluginId, pageId, title, reference) => {
    const active = store.get(tabsAtom).find((tab) => tab.id === store.get(activeTabIdAtom))
    const task = reference ?? (active && (active.type === 'chat' || active.type === 'agent')
      ? { kind: active.type, sessionId: active.sessionId } : undefined)
    await window.electronAPI.activatePluginPage(pluginId, pageId, task)
    const opened = openPluginTab(store.get(tabsAtom), { pluginId, pageId, title })
    store.set(tabsAtom, opened.tabs); store.set(activeTabIdAtom, opened.activeTabId)
    store.set(appModeAtom, 'scratch'); store.set(settingsOpenAtom, false)
    store.set(currentConversationIdAtom, null); store.set(currentAgentSessionIdAtom, null); store.set(currentAgentWorkspaceIdAtom, null)
  }
}
