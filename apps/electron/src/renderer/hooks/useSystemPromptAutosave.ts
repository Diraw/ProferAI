import * as React from 'react'
import { useSetAtom } from 'jotai'
import { createPromptSaveQueue } from '@/lib/prompt-save-queue'
import { promptConfigAtom } from '@/atoms/system-prompt-atoms'
import type { SystemPromptUpdateInput } from '@profer/shared'

/** 提示词自动保存的防抖延迟（ms） */
export const PROMPT_SAVE_DEBOUNCE_MS = 500

/** 最长延迟（ms）：连续输入不停时也至少每 2s 落盘一次，避免编辑长期只停留在内存 */
export const PROMPT_SAVE_MAX_WAIT_MS = 2000

/**
 * 提示词编辑器的自动保存（`PromptSettings` 与 `PromptEditorSidebar` 共用）。
 *
 * 防抖、字段合并与卸载 flush 的语义都在框架无关的 `createPromptSaveQueue` 里并已被
 * 行为测试覆盖（见 `lib/prompt-save-queue.test.ts`）；这里只负责接线：
 * 调用 IPC 落盘、把返回值同步回全局配置、组件卸载时 flush。
 */
export function useSystemPromptAutosave(): (id: string, input: SystemPromptUpdateInput) => void {
  const setConfig = useSetAtom(promptConfigAtom)

  const queue = React.useMemo(
    () =>
      createPromptSaveQueue(async (id, input) => {
        const updated = await window.electronAPI.updateSystemPrompt(id, input)
        setConfig((prev) => ({
          ...prev,
          prompts: prev.prompts.map((p) => (p.id === updated.id ? updated : p)),
        }))
      }, PROMPT_SAVE_DEBOUNCE_MS, { maxWaitMs: PROMPT_SAVE_MAX_WAIT_MS }),
    [setConfig]
  )

  // 卸载时立即落盘：切走提示词或关闭面板不会丢掉最后一次编辑
  React.useEffect(() => {
    return () => {
      void queue.flush()
    }
  }, [queue])

  return React.useCallback(
    (id: string, input: SystemPromptUpdateInput): void => queue.queue(id, input),
    [queue]
  )
}
