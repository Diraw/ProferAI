import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Blocks } from 'lucide-react'
import { toast } from 'sonner'
import type { ProferPluginTaskReference } from '@profer/plugin-api'
import { installedPluginsAtom } from '@/atoms/plugin-system'
import { usePluginPage } from '@/hooks/usePluginPage'

function report(error: unknown): void { toast.error(error instanceof Error ? error.message : '无法打开插件') }
export function PluginSidebarEntries({ collapsed = false }: { collapsed?: boolean }): React.ReactElement | null {
  const plugins = useAtomValue(installedPluginsAtom), open = usePluginPage()
  const pages = plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => (plugin.manifest.contributes.pages ?? [])
    .filter((page) => page.placements?.includes('sidebar')).map((page) => ({ pluginId: plugin.manifest.id, page })))
  if (!pages.length) return null
  return <div className={collapsed ? 'max-h-40 overflow-y-auto space-y-1' : 'max-h-48 overflow-y-auto px-3 py-1 space-y-1'}>
    {pages.map(({ pluginId, page }) => <button key={`${pluginId}:${page.id}`} type="button" title={page.title} aria-label={page.title}
      className={`titlebar-no-drag flex items-center gap-2 rounded-xl text-sm text-muted-foreground hover:bg-primary/10 hover:text-foreground ${collapsed ? 'size-10 justify-center' : 'w-full px-3 py-2'}`}
      onClick={() => void open(pluginId, page.id, page.title).catch(report)}>
      <Blocks size={16} />{!collapsed && <span className="truncate">{page.title}</span>}
    </button>)}
  </div>
}
export function PluginMessageActions({ reference }: { reference: ProferPluginTaskReference }): React.ReactElement | null {
  const plugins = useAtomValue(installedPluginsAtom), open = usePluginPage()
  const actions = plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => (plugin.manifest.contributes.messageActions ?? [])
    .map((action) => ({ pluginId: plugin.manifest.id, action })))
  if (!actions.length) return null
  return <select aria-label="用插件处理消息" value="" className="max-w-40 rounded-md bg-transparent px-1 py-1 text-xs text-muted-foreground"
    onChange={(event) => {
      const selected = actions[Number(event.target.value)]
      if (selected) void open(selected.pluginId, selected.action.pageId, selected.action.title, { ...reference, selection: window.getSelection()?.toString().slice(0, 100_000) || undefined }).catch(report)
    }}>
    <option value="" disabled>用插件处理…</option>
    {actions.map(({ pluginId, action }, index) => <option value={index} key={`${pluginId}:${action.id}`}>{action.title}</option>)}
  </select>
}
