/**
 * PenInkLayer — 输入框内嵌的手写板
 *
 * 设计要点：
 * - 手写板不是浮窗，而是 composer 卡片内部的一块区域：同一个圆角、同一个边框、
 *   同一条底线分隔，卡片自然长高，工具栏留在底部——读起来是一个整体，不是两个窗口
 * - 笔点输入框只负责把板子叫出来，这一下不计入书写（编辑器照常获得焦点）
 * - 真正落笔必须在板子里；抬手空闲后调 macOS Vision 识别成文字，插到光标处
 * - 认不出来就明说，绝不往输入框塞图片附件
 * - 零轮询：笔的存在完全由 Pointer Events 表达
 *
 * 关于 pointerType：Wacom 在 macOS 上常把笔报成 'mouse'，但压力不是鼠标恒定的 0.5，
 * 所以判定是「pen 类型」或「mouse 类型且压力偏离 0.5」。
 */

import * as React from 'react'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import {
  buildStrokePath,
  INK_BASE_SIZE,
  strokesToPngDataUrl,
  type InkPoint,
  type InkStroke,
} from '@/lib/pen-ink'

/** 手写板高度 */
const PAD_HEIGHT = 190
/** 空置多久自动收起 */
const PAD_IDLE_CLOSE_MS = 8000
/** 小于这个位移视为点击，不落墨 */
const TAP_SLOP = 4
/** 低于这个位移不采样 */
const MIN_SEGMENT = 0.7
/** 抬手后多久自动识别 */
const DEFAULT_COMMIT_DELAY_MS = 1400
/** 笔点这些元素时当点击处理，不落墨 */
const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"], [contenteditable="false"]'

/** 总开关：出问题时可一键关掉，不影响输入框 */
export const PEN_INK_ENABLED = true

/** 笔 = pen 类型，或「mouse 类型但压力不是恒定 0.5」 */
function isPenLike(event: PointerEvent): boolean {
  if (event.pointerType === 'pen') return true
  if (event.pointerType !== 'mouse') return false
  return event.pressure > 0 && Math.abs(event.pressure - 0.5) > 0.02
}

export interface PenInkLayerProps {
  /** composer 卡片：用于量宽度、判定「笔点在输入框上」 */
  containerRef: React.RefObject<HTMLElement | null>
  /** 识别成功：把文本插回输入框 */
  onText: (text: string) => void
  /** 抬手后等待多久自动提交 */
  commitDelayMs?: number
}

export function PenInkLayer({
  containerRef,
  onText,
  commitDelayMs = DEFAULT_COMMIT_DELAY_MS,
}: PenInkLayerProps): React.ReactElement {
  const padRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const strokesRef = React.useRef<InkStroke[]>([])
  const currentRef = React.useRef<InkStroke | null>(null)
  const pendingRef = React.useRef<{ point: InkPoint; pointerId: number } | null>(null)
  const activeRef = React.useRef(false)
  const commitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const recognizingRef = React.useRef(false)
  /** 开发态诊断：记录一次落笔收到多少个 move，用于定位「一笔写不完」 */
  const moveCountRef = React.useRef(0)
  const dprRef = React.useRef(1)
  const colorRef = React.useRef('#111827')
  const [padVisible, setPadVisible] = React.useState(false)
  const [recognizing, setRecognizing] = React.useState(false)

  const onTextRef = React.useRef(onText)
  onTextRef.current = onText

  const setActive = React.useCallback((next: boolean) => {
    if (activeRef.current === next) return
    activeRef.current = next
    setPadVisible(next)
  }, [])

  const redraw = React.useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const dpr = dprRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = colorRef.current

    for (const stroke of strokesRef.current) {
      ctx.fill(buildStrokePath(stroke.points, stroke.size))
    }
    if (currentRef.current) {
      ctx.fill(buildStrokePath(currentRef.current.points, currentRef.current.size))
    }
  }, [])

  /**
   * 画布尺寸只从「卡片宽度 + 固定板高」算，并写死 CSS 宽高。
   *
   * 不能读 canvas 自己的 rect：canvas 是 replaced element，width:auto 时按 width 属性
   * 当固有尺寸，偏移约束不住，会「属性 ← rect ← 属性」自激翻倍，最后分配不出内存、
   * 渲染成一块白色区域。
   */
  const resizeCanvas = React.useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    dprRef.current = dpr
    const cssWidth = Math.max(1, Math.round(container.getBoundingClientRect().width))
    const cssHeight = PAD_HEIGHT

    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    const width = Math.round(cssWidth * dpr)
    const height = Math.round(cssHeight * dpr)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    colorRef.current = getComputedStyle(canvas).color || '#111827'
    redraw()
  }, [containerRef, redraw])

  const clearCommitTimer = React.useCallback(() => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
  }, [])

  const clearIdleTimer = React.useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  const schedulePadIdleRef = React.useRef<() => void>(() => {})

  /**
   * 空置收起：没有残留墨迹时 8s 收；有残留（识别失败）再多等一轮后强制收起，
   * 避免手写板永远挂在输入框上方。
   */
  const schedulePadIdle = React.useCallback(() => {
    clearIdleTimer()
    const wait = strokesRef.current.length === 0 ? PAD_IDLE_CLOSE_MS : PAD_IDLE_CLOSE_MS * 2
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null
      if (currentRef.current || recognizingRef.current) {
        schedulePadIdleRef.current()
        return
      }
      strokesRef.current = []
      redraw()
      setActive(false)
    }, wait)
  }, [clearIdleTimer, redraw, setActive])

  schedulePadIdleRef.current = schedulePadIdle

  const commit = React.useCallback(() => {
    clearCommitTimer()
    currentRef.current = null
    pendingRef.current = null

    // 识别期间又落笔：等这一批结束再提交，避免把新笔画一起清掉
    if (recognizingRef.current) return

    const batch = strokesRef.current.slice()
    if (batch.length === 0) return

    // 识别图放大、加白边、笔画加粗：OCR 对细笔画和紧贴边缘的图都不敏感
    const dataUrl = strokesToPngDataUrl(batch, { scale: 3, padding: 24, weight: 1.6 })
    const recognize = window.electronAPI?.recognizeHandwriting
    if (!dataUrl || typeof recognize !== 'function') {
      toast.warning('手写识别不可用')
      return
    }

    recognizingRef.current = true
    setRecognizing(true)
    void recognize(dataUrl)
      .then((result) => {
        const text = result?.text?.trim() ?? ''
        if (text.length > 0) {
          // 只摘掉这一批，识别期间新写的笔画保留
          strokesRef.current = strokesRef.current.filter((stroke) => !batch.includes(stroke))
          redraw()
          onTextRef.current(text)
          schedulePadIdle()
          return
        }
        // 只回文字，不回图片；认不出就保留墨迹，让用户接着写或重写
        if (result?.error === 'unsupported-platform') {
          toast.warning('当前系统暂不支持手写识别')
          return
        }
        if (result?.error === 'helper-missing') {
          toast.error('手写识别组件缺失，请重新安装应用')
          return
        }
        toast.warning('没认出文字，可以接着写或点 × 重来')
      })
      .catch((error: unknown) => {
        console.error('[PenInkLayer] 手写识别失败:', error)
        toast.error('手写识别失败')
      })
      .finally(() => {
        recognizingRef.current = false
        setRecognizing(false)
      })
  }, [clearCommitTimer, redraw, schedulePadIdle])

  const scheduleCommit = React.useCallback(() => {
    clearCommitTimer()
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null
      commit()
    }, commitDelayMs)
  }, [clearCommitTimer, commit, commitDelayMs])

  React.useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    resizeCanvas()
    const observer = new ResizeObserver(() => resizeCanvas())
    observer.observe(container)

    const pointFromEvent = (event: PointerEvent | MouseEvent): InkPoint => {
      const rect = canvas.getBoundingClientRect()
      const pressure = 'pressure' in event ? event.pressure : 0
      return { x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: pressure ?? 0 }
    }

    const within = (rect: DOMRect, event: PointerEvent): boolean =>
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom

    const handlePointerDown = (event: PointerEvent): void => {
      moveCountRef.current = 0
      if (import.meta.env.DEV) {
        console.debug('[pen] down', event.pointerType, 'p=', Number(event.pressure?.toFixed(2)))
      }
      if (!event.isPrimary) return
      if (!isPenLike(event)) return

      const target = event.target
      if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return

      // 板子开着：笔落在板子里才开始记账
      const pad = padRef.current
      if (activeRef.current && pad && within(pad.getBoundingClientRect(), event)) {
        event.preventDefault()
        event.stopPropagation()
        clearCommitTimer()
        clearIdleTimer()
        pendingRef.current = { point: pointFromEvent(event), pointerId: event.pointerId }
        return
      }

      // 笔落在输入框：只把板子叫出来，这一下不计入书写，点击行为照常
      if (within(container.getBoundingClientRect(), event)) {
        setActive(true)
        schedulePadIdle()
      }
    }

    const startStroke = (event: PointerEvent): void => {
      const pending = pendingRef.current
      if (!pending) return
      // 捕获到实际落笔元素（canvas）上：对非目标元素捕获在 Windows 上容易触发隐式释放
      const captureTarget = event.target instanceof Element ? event.target : canvas
      try {
        captureTarget.setPointerCapture(pending.pointerId)
      } catch {
        // 捕获失败不影响绘制，window 上的监听仍然收得到后续事件
      }
      currentRef.current = {
        points: [pending.point, pointFromEvent(event)],
        size: INK_BASE_SIZE,
      }
      pendingRef.current = null
      redraw()
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const pending = pendingRef.current
      if (pending && !currentRef.current) {
        const point = pointFromEvent(event)
        if (Math.hypot(point.x - pending.point.x, point.y - pending.point.y) < TAP_SLOP) return
        startStroke(event)
        return
      }

      const current = currentRef.current
      if (!current) return
      event.preventDefault()
      event.stopPropagation()

      moveCountRef.current += 1
      const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event]
      for (const sample of samples.length > 0 ? samples : [event]) {
        const point = pointFromEvent(sample)
        const last = current.points[current.points.length - 1]
        if (!last) break
        if (Math.hypot(point.x - last.x, point.y - last.y) < MIN_SEGMENT) continue
        current.points.push(point)
      }
      redraw()
    }

    const finishStroke = (event: PointerEvent): void => {
      if (pendingRef.current) {
        // 板子上的纯点击：不留墨
        pendingRef.current = null
        return
      }

      const current = currentRef.current
      if (!current) return
      event.preventDefault()
      event.stopPropagation()

      strokesRef.current.push(current)
      currentRef.current = null
      try {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      } catch {
        // 忽略
      }
      redraw()
      scheduleCommit()
    }

    const handlePointerUp = (event: PointerEvent): void => {
      if (import.meta.env.DEV) {
        console.debug('[pen]', event.type, event.pointerType, 'moves=', moveCountRef.current, 'pending=', !!pendingRef.current, 'drawing=', !!currentRef.current)
      }
      if (!pendingRef.current && !currentRef.current) return
      finishStroke(event)
    }

    const handleWindowBlur = (): void => {
      pendingRef.current = null
      if (currentRef.current) {
        const current = currentRef.current
        if (current.points.length > 1) strokesRef.current.push(current)
        currentRef.current = null
        redraw()
      }
      if (strokesRef.current.length > 0) commit()
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerUp, true)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerUp, true)
      window.removeEventListener('blur', handleWindowBlur)
      observer.disconnect()
      clearCommitTimer()
      clearIdleTimer()
    }
  }, [clearCommitTimer, clearIdleTimer, commit, containerRef, redraw, resizeCanvas, scheduleCommit, schedulePadIdle, setActive])

  return (
    <div
      className={[
        'grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out',
        padVisible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      ].join(' ')}
      aria-hidden={!padVisible}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          ref={padRef}
          className="relative rounded-t-[17px] border-b-[0.5px] border-surface-border bg-input/40"
          style={{
            height: PAD_HEIGHT,
            // Windows 上不声明 touch-action，笔拖动会被当成滚动/手势，浏览器直接发 pointercancel，
            // 表现就是「一笔写不完」。user-select 顺带避免拖出选区。
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        >
          {/* 手写纸感底纹 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              backgroundImage: 'radial-gradient(circle, hsl(var(--border) / 0.55) 1px, transparent 1px)',
              backgroundSize: '18px 18px',
            }}
          />
          <div className="pointer-events-none absolute left-3.5 top-2.5 flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
            <Pencil className="size-3" />
            <span>{recognizing ? '识别中…' : '手写板 · 写完自动转文字'}</span>
          </div>
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="absolute left-0 top-0 cursor-crosshair text-foreground"
            style={{ touchAction: 'none' }}
          />
        </div>
      </div>
    </div>
  )
}

interface PenInkGuardState {
  failed: boolean
}

/**
 * 手写是可选增强：墨迹层自身抛错时只停用自己，不能让输入框跟着挂掉。
 */
class PenInkGuard extends React.Component<{ children: React.ReactNode }, PenInkGuardState> {
  override state: PenInkGuardState = { failed: false }

  static getDerivedStateFromError(): PenInkGuardState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[PenInkLayer] 手写板异常，已自动停用:', error, info.componentStack)
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** 带异常隔离的手写板，composer 里一律用这个。 */
export function PenInkLayerSafe(props: PenInkLayerProps): React.ReactElement {
  return (
    <PenInkGuard>
      <PenInkLayer {...props} />
    </PenInkGuard>
  )
}
