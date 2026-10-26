import * as React from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Switch } from '@profer/ui/primitives/switch'
import { Popover, PopoverAnchor, PopoverContent } from '@profer/ui/primitives/popover'
import { isMac } from '@/lib/shortcut-registry'
import { AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'

interface AgentSendButtonProps {
  canSend: boolean
  /** true = Ctrl/Cmd+Enter 发送，false = Enter 发送 */
  sendWithCmdEnter: boolean
  onToggleSendWithCmdEnter: (next: boolean) => void
  onSend: () => void
}

/** 悬停关闭延迟（ms），与上下文按钮 / 思考模式弹层保持一致 */
const HOVER_CLOSE_DELAY = 150

/**
 * 输入框发送按钮 + 悬停弹层。
 *
 * 弹层里放「发送键」拨码开关（复用预设菜单的 Switch），让用户在发送点旁边
 * 直接切换 Enter / Ctrl+Enter 语义，不必进设置页。
 *
 * 交互与上下文按钮一致：Radix Popover 承载（自带 fade/zoom/slide 过渡、align=center
 * 居中于触发按钮），鼠标进入触发区打开、离开 150ms 后关闭。
 * 这里用 PopoverAnchor 而不是 PopoverTrigger：点击发送不应顺带开合弹层。
 */
export function AgentSendButton({
  canSend,
  sendWithCmdEnter,
  onToggleSendWithCmdEnter,
  onSend,
}: AgentSendButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const closeTimerRef = React.useRef<number | null>(null)
  const keyLabel = `${isMac ? '⌘' : 'Ctrl'}+Enter`

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [cancelClose])

  React.useEffect(() => cancelClose, [cancelClose])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          className="flex items-center"
          onMouseEnter={() => { cancelClose(); setOpen(true) }}
          onMouseLeave={scheduleClose}
        >
          <AgentComposerToolTrigger
            label={sendWithCmdEnter ? `发送消息（${keyLabel}）` : '发送消息（Enter）'}
            state={canSend ? 'active' : 'muted'}
            className="disabled:cursor-not-allowed"
            onClick={() => { setOpen(false); onSend() }}
            disabled={!canSend}
          >
            <CornerDownLeft className="size-[22px]" />
          </AgentComposerToolTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-auto py-2 px-3"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex flex-col items-center gap-1.5">
          <div className="text-[12px] leading-4 text-foreground/80">
            发送（{sendWithCmdEnter ? keyLabel : 'Enter'}）
          </div>
          {/* 两档同色（只用皮肤已定义的 primary）：位置区分档位，没有关闭态的灰 */}
          <Switch
            checked={sendWithCmdEnter}
            onCheckedChange={onToggleSendWithCmdEnter}
            aria-label="切换发送快捷键"
            className="scale-90 data-[state=checked]:bg-primary data-[state=unchecked]:bg-primary"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
