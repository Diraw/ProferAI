import * as React from 'react'
import { ChevronRight, Download, Play, RefreshCw, RotateCcw, Square } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { toast } from 'sonner'
import { SettingsSection, SettingsToggle } from './primitives'
import type { FrpConfig } from '../../../main/lib/remote-frp-core'
import type { FrpStatus } from '../../../main/lib/remote-frp-service'
const initial: FrpConfig = { publicMode: 'pinned', serverAddr: '', serverPort: 7000, remotePort: 17788, authToken: '', publicUrl: '', startOnLaunch: false, serverVersion: '0.71.0', trustedCaFile: '' }
export function RemoteFrpSettings(): React.ReactElement {
  const [config, setConfig] = React.useState(initial)
  const [status, setStatus] = React.useState<FrpStatus | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState('')
  const [instructions, setInstructions] = React.useState('')
  const run = async (action: Parameters<typeof window.electronAPI.remoteFrp>[0], input?: FrpConfig | string): Promise<unknown> => {
    if (action !== 'deployment-instructions-text') setInstructions('')
    setBusy(true)
    try {
      const next = await window.electronAPI.remoteFrp(action, input)
      if (next && typeof next === 'object') setStatus(next)
      else if (typeof next === 'string' && action !== 'deployment-instructions-text') setResult(next)
      return next
    } catch (e) { const text = e instanceof Error ? e.message : 'FRP 操作失败'; setResult(text); toast.error(text); return null } finally { setBusy(false) }
  }
  // 草稿随“启动 / 导出 / 显示部署指令”回传主进程落盘；状态未就绪时不回传，避免空表单覆盖已保存配置。
  const draft = (): FrpConfig | undefined => (status ? config : undefined)
  const update = (patch: Partial<FrpConfig>): void => { setConfig((c) => ({ ...c, ...patch })); setInstructions('') }
  React.useEffect(() => { void window.electronAPI.remoteFrp('status').then((s) => { if (s && typeof s === 'object') { setStatus(s); if (s.config) setConfig({ ...s.config, authToken: '' }) } }) }, [])
    React.useEffect(() => { if (busy) return; let active = true; const timer = setInterval(() => { void window.electronAPI.remoteFrp('status').then((s) => { if (active && s && typeof s === 'object') setStatus(s) }).catch(() => setResult('读取 FRP 状态失败')) }, 3000); return () => { active = false; clearInterval(timer) } }, [busy])
  const toggleInstructions = async (): Promise<void> => {
    if (instructions) { setInstructions(''); return }
    const next = await run('deployment-instructions-text', draft())
    if (typeof next === 'string') setInstructions(next)
  }
  const install = async (): Promise<void> => { if (draft()) { const saved = await run('save', draft()); if (saved === null) return } await run('install', config.serverVersion) }
  const field = (key: keyof FrpConfig, label: string, type = 'text'): React.ReactElement => <label className="grid min-w-0 gap-1 text-xs"><span>{label}</span><Input aria-label={label} type={type} value={String(config[key])} autoComplete="off" onChange={(e) => { setConfig((c) => ({ ...c, [key]: type === 'number' ? Number(e.target.value) : e.target.value })); setInstructions('') }} /></label>
  const generated = status?.generated
  return <SettingsSection title="自建 FRP" description="填公网 IP/域名与端口即可，Token 与证书由 Profer 自动生成托管。">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="grid min-w-0 gap-1 text-xs"><span>公网 TLS 模式</span><select aria-label="公网 TLS 模式" className="h-9 rounded border bg-background px-2" value={config.publicMode ?? (config.publicUrl ? 'system' : 'pinned')} onChange={(e) => update({ publicMode: e.target.value === 'system' ? 'system' : 'pinned' })}><option value="pinned">无域名 IP · Android 扫码 Pin</option><option value="system">高级 · 系统可信域名 WSS</option></select></label>
      {field('serverAddr', 'frps 公网 IP / 域名')}{field('serverPort', 'FRP 控制端口', 'number')}
      {field('remotePort', 'TCP 映射端口', 'number')}{config.publicMode === 'system' && field('publicUrl', '系统可信公网 WSS 地址')}
    </div>
    <SettingsToggle label="随 Profer 启动" checked={config.startOnLaunch} onCheckedChange={(value) => update({ startOnLaunch: value })} />
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button disabled={busy} onClick={() => void run(status?.running ? 'stop' : 'start', status?.running ? undefined : draft())}>{status?.running ? <Square className="size-4" /> : <Play className="size-4" />}{status?.running ? '停止' : '启动'}</Button>
      <Button variant="outline" disabled={busy} onClick={() => void run('export', draft())}><Download className="size-4" />导出部署 zip</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void toggleInstructions()}><ChevronRight className={instructions ? 'size-4 rotate-90' : 'size-4'} />{instructions ? '收起部署指令' : '点击显示部署指令'}</Button>
    </div>
    {instructions && <div className="mt-3 rounded-lg bg-muted/30 border border-border/30 px-4 py-3">
      <p className="text-sm text-muted-foreground">以下部署指令含真实 FRP Token 与私钥，请勿外传。推荐保存为 deploy.sh 后执行 bash deploy.sh，也可整段粘贴到服务器 root 会话执行（失败不会关闭终端）；脚本会自动判定 CPU 架构、下载并用官方 SHA256 校验 frps、写配置与证书、启动 systemd。生成指令需要联网获取官方归档摘要。</p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{instructions}</pre>
    </div>}
    <output className="mt-3 block break-words text-xs">{status?.readiness === 'draft' ? `草稿 · 缺少 ${status.missing?.join('、') || '必填输入'}` : status?.readiness === 'tunnel_ready' ? '输入已就绪，连接尚未验证' : '尚未保存配置'}</output>
    <output className="mt-1 block break-words text-xs" role="status">{result || status?.error || (status?.running ? `frpc 运行中（PID ${status.pid}），应用链路未验证` : 'frpc 已停止')}</output>
    {!!status?.log?.length && <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{status.log.join('\n')}</pre>}
    <details className="mt-3 rounded border border-border/30 px-3 py-2 text-xs">
      <summary className="cursor-pointer select-none">高级</summary>
      <div className="mt-2 grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">frpc 客户端 {status?.installedVersion ?? '未安装'} · 推荐 {status?.recommendedVersion ?? '未检查'}</span>
          <Button variant="ghost" size="icon" title="检查官方稳定版本" disabled={busy} onClick={() => void run('check')}><RefreshCw className="size-4" /></Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="frps 固定版本" className="h-8 w-24" value={config.serverVersion} autoComplete="off" onChange={(e) => update({ serverVersion: e.target.value })} list="frp-versions" />
          <datalist id="frp-versions">{status?.availableVersions.map((v) => <option key={v} value={v} />)}</datalist>
          <Button variant="outline" size="sm" disabled={busy || status?.running} onClick={() => void install()}><Download className="size-3.5" />安装</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run('rollback')}><RotateCcw className="size-3.5" />回滚</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">托管材料 Token {generated?.token ? '已生成' : '未生成'} · 控制 CA {generated?.controlCa ? '已生成' : '未生成'}</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (window.confirm('重新生成会更换 FRP Token、控制 CA 与 server 私钥；服务器必须重新部署，正在运行的隧道会停止。继续？')) void run('regenerate', draft()) }}><RotateCcw className="size-3.5" />重新生成材料</Button>
        </div>
      </div>
    </details>
  </SettingsSection>
}
