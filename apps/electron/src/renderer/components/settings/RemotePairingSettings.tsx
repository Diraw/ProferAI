import * as React from 'react'
import { RefreshCw, Unplug } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { toast } from 'sonner'
export function RemotePairingSettings(): React.ReactElement {
  const [qr, setQr] = React.useState<{ dataUrl: string; expiresAt: number } | null>(null)
  const [remaining, setRemaining] = React.useState(0)
  const [bindings, setBindings] = React.useState<Array<{ id: string; name: string; createdAt: number }>>([])
  const [busy, setBusy] = React.useState(false)
  const refresh = React.useCallback(async () => { setBusy(true); try { setQr(await window.electronAPI.getRemotePairingQr()); setBindings(await window.electronAPI.getRemoteBindings()) } catch (e) { toast.error(e instanceof Error ? e.message : '配对失败') } finally { setBusy(false) } }, [])
  React.useEffect(() => { void refresh(); const timer = setInterval(() => { void window.electronAPI.getRemoteBindings().then(setBindings) }, 5000); return () => clearInterval(timer) }, [refresh])
  React.useEffect(() => { const update = () => setRemaining(Math.max(0, Math.ceil(((qr?.expiresAt ?? 0) - Date.now()) / 1000))); update(); const timer = setInterval(update, 1000); return () => clearInterval(timer) }, [qr])
  return <div className="space-y-3 px-4 py-3">
    <div className="flex flex-wrap items-center gap-4">
      {qr && remaining > 0 ? <img src={qr.dataUrl} alt="Pocket 一次性配对二维码" className="size-56 max-w-full bg-white" /> : <span className="text-sm">二维码已过期</span>}
      <div className="flex items-center gap-2 text-sm"><span className="tabular-nums">{remaining} 秒</span><Button variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw className="size-4" />刷新配对码</Button></div>
    </div>
    {bindings.map((b) => <div key={b.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{b.name}</span><Button variant="ghost" size="icon" title="撤销设备凭据" onClick={() => { void window.electronAPI.revokeRemoteBinding(b.id).then(() => window.electronAPI.getRemoteBindings()).then(setBindings) }}><Unplug className="size-4" /></Button></div>)}
  </div>
}
