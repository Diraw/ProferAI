import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { ProferPluginRoutingState } from '@profer/plugin-api'
import { installedPluginsAtom, pluginPanelsAtom } from '@/atoms/plugin-system'
import { usePluginPage } from '@/hooks/usePluginPage'

export function PluginTaskControls({ kind, sessionId }: { kind: 'chat' | 'agent'; sessionId: string }): React.ReactElement | null {
  const plugins = useAtomValue(installedPluginsAtom), open = usePluginPage()
  const setPanels = useSetAtom(pluginPanelsAtom)
  const [state, setState] = React.useState<ProferPluginRoutingState>({ pluginId: null })
  const [busy, setBusy] = React.useState(false)
  const key = `${kind}:${sessionId}`
  const report = (error: unknown): void => { toast.error(error instanceof Error ? error.message : '插件操作失败') }
  React.useEffect(() => {
    let active = true
    setState({ pluginId: null })
    void window.electronAPI.getPluginRouting(key).then((value) => { if (active) setState(value) }).catch(report)
    const unsubscribe = window.electronAPI.onPluginRoutingChanged((event) => { if (active && event.key === key) setState(event.state) })
    return () => { active = false; unsubscribe() }
  }, [key])
  const enabled = plugins.filter((plugin) => plugin.enabled)
  const routers = enabled.filter((plugin) => plugin.manifest.contributes.modelRoutingPolicies?.length && plugin.grantedPermissions?.includes('modelRouting.rules.write'))
  const pages = enabled.flatMap((plugin) => (plugin.manifest.contributes.pages ?? []).map((page) => ({ pluginId: plugin.manifest.id, page })))
  const panelPages = pages.filter(({ page }) => page.placements?.includes('panel'))
  if (!pages.length && !routers.length && !state.pluginId) return null
  const choose = async (pluginId: string): Promise<void> => {
    setBusy(true)
    try { await window.electronAPI.setPluginRouting(key, pluginId || null); setState({ pluginId: pluginId || null }) }
    catch (error) { report(error) } finally { setBusy(false) }
  }
  return <div className="titlebar-no-drag flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    {(routers.length > 0 || state.pluginId) && <select aria-label="本任务的模型路由" disabled={busy} value={state.pluginId ?? ''}
      className="max-w-48 rounded-lg bg-surface-raised px-2 py-1.5" onChange={(event) => void choose(event.target.value)}>
      <option value="">手动选择模型</option>
      {state.pluginId && !routers.some((plugin) => plugin.manifest.id === state.pluginId) && <option value={state.pluginId}>路由插件不可用（回退手动）</option>}
      {routers.map((plugin) => <option key={plugin.manifest.id} value={plugin.manifest.id}>自动路由 · {plugin.manifest.name}</option>)}
    </select>}
    {state.lastDecision && <span className="max-w-64 truncate" title={`${state.lastDecision.modelId} · ${state.lastDecision.reason}`}>本轮：{state.lastDecision.modelId} · {state.lastDecision.reason}</span>}
    {panelPages.length > 0 && <select aria-label="打开插件侧面板" value="" className="max-w-40 rounded-lg bg-surface-raised px-2 py-1.5" onChange={(event) => {
      const item = panelPages[Number(event.target.value)]
      if (item) setPanels((current) => new Map(current).set(key, { pluginId: item.pluginId, pageId: item.page.id, title: item.page.title }))
    }}>
      <option value="" disabled>插件侧面板…</option>
      {panelPages.map(({ pluginId, page }, index) => <option key={`${pluginId}:${page.id}`} value={index}>{page.title}</option>)}
    </select>}
    {pages.length > 0 && <select aria-label="用插件处理当前任务" value="" className="max-w-40 rounded-lg bg-surface-raised px-2 py-1.5"
      onChange={(event) => {
        const item = pages[Number(event.target.value)]
        if (item) void open(item.pluginId, item.page.id, item.page.title, { kind, sessionId }).catch(report)
      }}>
      <option value="" disabled>插件工具…</option>
      {pages.map(({ pluginId, page }, index) => <option key={`${pluginId}:${page.id}`} value={index}>{page.title}</option>)}
    </select>}
  </div>
}
