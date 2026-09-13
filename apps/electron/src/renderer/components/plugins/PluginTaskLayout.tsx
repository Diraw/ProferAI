import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { installedPluginsAtom, pluginPanelsAtom } from '@/atoms/plugin-system'
import { PluginViewport } from '@/components/tabs/PluginViewport'

export function PluginTaskLayout({ kind, sessionId, children }: { kind: 'chat' | 'agent'; sessionId: string; children: React.ReactNode }): React.ReactElement {
  const [panels, setPanels] = useAtom(pluginPanelsAtom)
  const plugins = useAtomValue(installedPluginsAtom)
  const key = `${kind}:${sessionId}`, panel = panels.get(key)
  const available = panel && plugins.some((plugin) => plugin.enabled && plugin.manifest.id === panel.pluginId
    && plugin.manifest.contributes.pages?.some((page) => page.id === panel.pageId && page.placements?.includes('panel')))
  React.useEffect(() => {
    if (available && panel) void window.electronAPI.activatePluginPage(panel.pluginId, panel.pageId, { kind, sessionId })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : '插件侧面板打开失败'))
  }, [available, panel, kind, sessionId, plugins])
  const close = (): void => {
    if (panel) void window.electronAPI.closePluginView(panel.pluginId, panel.pageId).catch(() => undefined)
    setPanels((current) => { const next = new Map(current); next.delete(key); return next })
  }
  return <div className="flex h-full min-h-0 min-w-0">
    <div className="h-full min-h-0 min-w-0 flex-1">{children}</div>
    {available && panel && <aside aria-label={panel.title} className="flex h-full min-h-0 w-[360px] max-w-[45%] shrink-0 flex-col gap-2 bg-surface-raised/60 p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{panel.title}</span><button type="button" onClick={close} aria-label="关闭插件侧面板" className="rounded-md p-1 hover:bg-muted"><X size={16} /></button></div>
      <div className="min-h-0 flex-1"><PluginViewport pluginId={panel.pluginId} pageId={panel.pageId} visible /></div>
    </aside>}
  </div>
}
