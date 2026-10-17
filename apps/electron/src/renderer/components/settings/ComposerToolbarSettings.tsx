import * as React from 'react'
import { useAtom } from 'jotai'
import { ChevronDown, ChevronUp, GripVertical, RotateCcw, Save } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Switch } from '@profer/ui/primitives/switch'
import { SettingsCard, SettingsSection } from './primitives'
import {
  COMPOSER_TOOLBAR_DEFINITIONS,
  updateComposerToolbarSurfacePreferences,
  type ComposerToolbarSurface,
} from '@/lib/composer-toolbar-preferences'
import { composerToolbarPreferencesAtom } from '@/atoms/composer-toolbar-preferences'
import { toast } from 'sonner'
import type { ComposerToolbarPreferences } from '../../../types'

interface ToolbarDraftItem {
  key: string
  visible: boolean
  core: boolean
}

function orderedDraft(surface: ComposerToolbarSurface, preferences: ComposerToolbarPreferences): ToolbarDraftItem[] {
  const saved = preferences[surface] ?? {}
  return COMPOSER_TOOLBAR_DEFINITIONS[surface]
    .map((definition, index) => ({
      definition,
      index,
      order: saved[definition.key]?.order ?? index,
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ definition }) => ({
      key: definition.key,
      visible: definition.core ? true : saved[definition.key]?.visible !== false,
      core: definition.core === true,
    }))
}

export function ComposerToolbarSettings(): React.ReactElement {
  const [preferences, setPreferences] = useAtom(composerToolbarPreferencesAtom)
  const [surface, setSurface] = React.useState<ComposerToolbarSurface>('chat')
  const [draft, setDraft] = React.useState(() => orderedDraft('chat', preferences))
  const [draggedKey, setDraggedKey] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    setDraft(orderedDraft(surface, preferences))
  }, [preferences, surface])

  const persist = React.useCallback(async (nextDraft: ToolbarDraftItem[], nextSurface = surface): Promise<void> => {
    const orderedKeys = nextDraft.map((item) => item.key)
    const visibleKeys = new Set(nextDraft.filter((item) => item.visible || item.core).map((item) => item.key))
    const nextPreferences = updateComposerToolbarSurfacePreferences(preferences, nextSurface, orderedKeys, visibleKeys)
    setPreferences(nextPreferences)
    setSaving(true)
    try {
      await window.electronAPI.updateSettings({ composerToolbarPreferences: nextPreferences })
      toast.success('工具栏设置已保存')
    } catch (error) {
      console.error('[ComposerToolbarSettings] 保存失败:', error)
      toast.error('工具栏设置保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }, [preferences, setPreferences, surface])

  const updateDraft = (nextDraft: ToolbarDraftItem[]): void => {
    setDraft(nextDraft)
    void persist(nextDraft)
  }

  const move = (index: number, offset: -1 | 1): void => {
    const target = index + offset
    if (target < 0 || target >= draft.length) return
    const next = [...draft]
    const [item] = next.splice(index, 1)
    if (!item) return
    next.splice(target, 0, item)
    updateDraft(next)
  }

  const toggle = (index: number, visible: boolean): void => {
    const item = draft[index]
    if (!item || item.core) return
    const next = draft.map((entry, entryIndex) => entryIndex === index ? { ...entry, visible } : entry)
    updateDraft(next)
  }

  const handleDrop = (targetIndex: number): void => {
    if (!draggedKey) return
    const sourceIndex = draft.findIndex((item) => item.key === draggedKey)
    setDraggedKey(null)
    if (sourceIndex < 0 || sourceIndex === targetIndex) return
    const next = [...draft]
    const [item] = next.splice(sourceIndex, 1)
    if (!item) return
    next.splice(targetIndex, 0, item)
    updateDraft(next)
  }

  const reset = (): void => {
    const next = orderedDraft(surface, {})
    updateDraft(next)
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="输入工具栏"
        description="只影响桌面 Chat 和 Agent 输入区；移动端工具栏保持独立布局。模型和附件始终显示，位置可以调整。"
        action={(
          <Button type="button" size="sm" variant="outline" onClick={reset} disabled={saving}>
            <RotateCcw size={14} aria-hidden="true" />
            <span>恢复默认</span>
          </Button>
        )}
      >
        <div className="inline-flex rounded-lg bg-muted p-1" role="tablist" aria-label="工具栏模式">
          {(['chat', 'agent'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={surface === entry}
              onClick={() => setSurface(entry)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 ${surface === entry ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {entry === 'chat' ? 'Chat' : 'Agent'}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">拖动左侧手柄调整所有工具的顺序，也可以使用上移和下移按钮。模型和附件不可关闭；关闭其他工具后，它会从桌面输入工具栏移除。</p>
        <SettingsCard divided={false} className="overflow-hidden border border-surface-border/50">
          <div role="list" aria-label={`${surface === 'chat' ? 'Chat' : 'Agent'} 工具栏工具`}>
            {draft.map((item, index) => {
              const definition = COMPOSER_TOOLBAR_DEFINITIONS[surface].find((entry) => entry.key === item.key)
              if (!definition) return null
              return (
                <div
                  key={item.key}
                  role="listitem"
                  draggable
                  onDragStart={() => setDraggedKey(item.key)}
                  onDragEnd={() => setDraggedKey(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleDrop(index)}
                  className="flex min-h-14 items-center gap-3 border-b border-surface-border/40 px-3 py-2 last:border-b-0"
                >
                  <button
                    type="button"
                    aria-label={`拖动${definition.label}`}
                    title="拖动调整顺序"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-control focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <GripVertical size={16} aria-hidden="true" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{definition.label}</div>
                    <div className="text-xs text-muted-foreground">{definition.description}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="icon" variant="ghost" aria-label={`上移${definition.label}`} title={`上移${definition.label}`} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ChevronUp size={16} aria-hidden="true" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" aria-label={`下移${definition.label}`} title={`下移${definition.label}`} disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                      <ChevronDown size={16} aria-hidden="true" />
                    </Button>
                    <Switch checked={item.visible} disabled={item.core || saving} aria-label={`${definition.label}显示`} onCheckedChange={(value) => toggle(index, value)} />
                  </div>
                </div>
              )
            })}
          </div>
        </SettingsCard>
        <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <Save size={14} aria-hidden="true" />
          {saving ? '正在保存...' : '修改会立即保存'}
        </div>
      </SettingsSection>
    </div>
  )
}
