import * as React from 'react'
import { Brain, Paperclip } from 'lucide-react'
import type { ComposerToolbarItem } from '@/components/ai-elements/composer/ComposerToolbar'
import type { ComposerToolbarPreferences } from '../../../types'
import { applyComposerToolbarPreferences } from '@/lib/composer-toolbar-preferences'
import { AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'
import { SpeechButton } from '@/components/ai-elements/speech-button'
import { ModelSelector } from './ModelSelector'
import { ToolSelectorPopover } from './ToolSelectorPopover'
import { ContextSettingsPopover } from './ContextSettingsPopover'
import { ClearContextButton } from './ClearContextButton'

export interface ChatComposerToolbarConfig {
  thinkingEnabled: boolean
  voiceDictationEnabled: boolean
  onToggleThinking: () => void
  onOpenFileDialog: () => void
  onClearContext?: () => void
  toolbarPreferences?: ComposerToolbarPreferences
}

/** Chat 工具栏的声明式装配点；页面只提供会话状态和动作，不负责排列策略。 */
export function createChatComposerToolbarItems(config: ChatComposerToolbarConfig): ComposerToolbarItem[] {
  const { thinkingEnabled, voiceDictationEnabled, onToggleThinking, onOpenFileDialog, onClearContext, toolbarPreferences } = config
  return applyComposerToolbarPreferences('chat', [
    { key: 'model', canOverflow: false, node: <ModelSelector composerTool /> },
    {
      key: 'attach',
      node: (
        <AgentComposerToolTrigger label="添加附件" tooltip="添加附件" onClick={onOpenFileDialog}>
          <Paperclip className="size-5" />
        </AgentComposerToolTrigger>
      ),
    },
    {
      key: 'thinking',
      node: (
        <AgentComposerToolTrigger
          label={thinkingEnabled ? '关闭思考模式' : '开启思考模式'}
          tooltip={thinkingEnabled ? '关闭思考模式' : '开启思考模式'}
          state={thinkingEnabled ? 'active' : 'default'}
          onClick={onToggleThinking}
        >
          <Brain className="size-5" />
        </AgentComposerToolTrigger>
      ),
    },
    ...(voiceDictationEnabled ? [{ key: 'speech', node: <SpeechButton composerTool /> }] : []),
    { key: 'tools', node: <ToolSelectorPopover composerTool /> },
    { key: 'context', node: <ContextSettingsPopover composerTool /> },
    { key: 'clear', node: <ClearContextButton composerTool onClick={onClearContext} /> },
  ], toolbarPreferences)
}
