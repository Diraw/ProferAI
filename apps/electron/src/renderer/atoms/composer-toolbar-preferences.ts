import { atom } from 'jotai'
import type { ComposerToolbarPreferences } from '../../types'
import { normalizeComposerToolbarPreferences } from '../lib/composer-toolbar-preferences'

export const composerToolbarPreferencesAtom = atom<ComposerToolbarPreferences>(
  normalizeComposerToolbarPreferences(undefined),
)

export async function initializeComposerToolbarPreferences(
  setPreferences: (preferences: ComposerToolbarPreferences) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setPreferences(normalizeComposerToolbarPreferences(settings.composerToolbarPreferences))
  } catch (error) {
    console.error('[ComposerToolbar] 加载工具栏偏好失败:', error)
  }
}
