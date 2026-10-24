import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { developerModeEnabledAtom } from '@/atoms/developer-mode'
import { settingsTabAtom } from '@/atoms/settings-tab'
import { SettingsCard, SettingsSection, SettingsToggle } from './primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@profer/ui/primitives/alert-dialog'

export function DeveloperSettings(): React.ReactElement {
  const [developerModeEnabled, setDeveloperModeEnabled] = useAtom(developerModeEnabledAtom)
  const setActiveTab = useSetAtom(settingsTabAtom)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const [exitOpen, setExitOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const exitDeveloperMode = async (): Promise<void> => {
    if (!developerModeEnabled || savingRef.current) return
    savingRef.current = true
    setError(null)
    setSaving(true)
    try {
      const settings = await window.electronAPI.updateSettings({ developerModeEnabled: false })
      if (settings.developerModeEnabled !== false) throw new Error('应用未确认关闭开发者模式')
      setDeveloperModeEnabled(false)
      setExitOpen(false)
      setActiveTab('general')
      toast.success('开发者模式已关闭')
    } catch (error) {
      setError(`关闭开发者模式失败：${error instanceof Error ? error.message : String(error)}`)
      toast.error('关闭开发者模式失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (!developerModeEnabled) return <SettingsSection title="开发者模式" description="开发者模式尚未启用；此页不可修改实验设置。"><SettingsCard divided={false} className="p-4 text-sm text-muted-foreground">请通过应用已有入口管理开发者模式。</SettingsCard></SettingsSection>

  return (
    <div className="space-y-6" aria-busy={saving}>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <SettingsSection
        title="开发者模式"
        description="管理开发者与插件能力。开发者模式不会绕过权限、安全规则或模型服务端约束。"
      >
        <SettingsCard divided={false} className="p-4 text-sm leading-6 text-muted-foreground">
          开发者模式只控制开发者与插件入口的可见性；Agent 的基础表达规则、权限和运行时能力由主进程策略统一管理。
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="退出开发者模式" description="关闭后会隐藏开发者与插件入口；已安装插件及其数据不会被删除。">
        <Button type="button" variant="outline" onClick={() => setExitOpen(true)} disabled={saving}>
          退出开发者模式
        </Button>
      </SettingsSection>
      <AlertDialog open={exitOpen} onOpenChange={(open) => { if (!savingRef.current) setExitOpen(open) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>退出开发者模式？</AlertDialogTitle><AlertDialogDescription>开发者和插件入口会隐藏；已安装插件及私有数据保留。</AlertDialogDescription></AlertDialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter><AlertDialogCancel disabled={saving}>取消</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void exitDeveloperMode() }}>{saving ? '关闭中…' : '确认退出'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
