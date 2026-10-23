/**
 * 滚动条的按需显隐（对话区原生滚动条、右侧滚动进度条共用）。
 *
 * macOS 习惯：滚动条只在用户主动滚动时出现，停手后淡出。
 * 这里只负责给目标元素打 `data-scrolling` 标记，具体样式见 globals.css：
 * - 原生滚动条：`.profer-scroll-region[data-scrolling='true']`
 * - 进度条：`.scroll-progress-track[data-scrolling='true']`
 *
 * 注意：程序性滚动（流式输出自动跟随、内容变高）不算用户滚动，
 * 只有 wheel / 触摸滑动 / 键盘翻页 / 直接操作滚动条才会露出滚动条。
 */

/** 最后一次滚动后保持可见的时长，给用户一个"刚滚过"的视觉落点。 */
export const SCROLLBAR_REVEAL_IDLE_MS = 700

/** 与浏览器滚动行为一致的翻页键。 */
const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']

export interface ScrollbarReveal {
  /** 标记为滚动中；重复调用会顺延隐藏时间。 */
  reveal: () => void
  /** 当前是否处于可见状态。 */
  isVisible: () => boolean
  /** 清理计时器、解绑监听并移除标记。 */
  dispose: () => void
}

interface ScrollbarRevealOptions {
  idleMs?: number
  /** 便于测试注入；默认 setTimeout。 */
  schedule?: (callback: () => void, ms: number) => number
  cancel?: (id: number) => void
  /**
   * 在这个元素上监听用户滚动交互。
   *
   * 原生滚动条的标记就打在滚动容器自己身上，调用方已经在处理交互事件，
   * 所以不传；进度条渲染在滚动容器外面（Conversation 的兄弟节点），
   * 需要它自己监听容器上的滚轮/触摸/翻页键。
   */
  watchElement?: HTMLElement | null
}

/**
 * 事件目标是否落在容器内部的另一个可滚动区域（代码块、嵌套列表等）。
 * 这类滚动不该让外层滚动条亮起来。
 */
export function isNestedScroller(target: EventTarget | null, boundary: HTMLElement): boolean {
  const elementCtor = typeof HTMLElement === 'undefined' ? null : HTMLElement
  let node = elementCtor && target instanceof elementCtor ? target : null
  while (node && node !== boundary) {
    const overflow = getComputedStyle(node).overflowY
    if (/auto|scroll/.test(overflow) && node.scrollHeight > node.clientHeight) return true
    node = node.parentElement
  }
  return false
}

function bindUserScroll(el: HTMLElement, reveal: () => void): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (!isNestedScroller(event.target, el)) reveal()
  }
  const onTouchMove = (event: TouchEvent): void => {
    if (!isNestedScroller(event.target, el)) reveal()
  }
  // 只有直接点/拖滚动条本体（target 为容器自身）才算，避免点消息时进度条闪一下。
  const onPointerDown = (event: PointerEvent): void => {
    if (event.target === el) reveal()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (SCROLL_KEYS.includes(event.key)) reveal()
  }
  el.addEventListener('wheel', onWheel, { passive: true })
  el.addEventListener('touchmove', onTouchMove, { passive: true })
  el.addEventListener('pointerdown', onPointerDown, { passive: true })
  el.addEventListener('keydown', onKeyDown)
  return () => {
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('keydown', onKeyDown)
  }
}

export function attachScrollbarReveal(
  el: HTMLElement,
  options: ScrollbarRevealOptions = {}
): ScrollbarReveal {
  const idleMs = options.idleMs ?? SCROLLBAR_REVEAL_IDLE_MS
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms) as unknown as number)
  const cancel = options.cancel ?? ((id) => clearTimeout(id))
  let timer: number | null = null

  const clear = (): void => {
    if (timer !== null) cancel(timer)
    timer = null
  }

  const reveal = (): void => {
    el.dataset.scrolling = 'true'
    clear()
    timer = schedule(() => {
      timer = null
      delete el.dataset.scrolling
    }, idleMs)
  }

  const detach = options.watchElement ? bindUserScroll(options.watchElement, reveal) : null

  return {
    reveal,
    isVisible: () => el.dataset.scrolling === 'true',
    dispose: () => {
      detach?.()
      clear()
      delete el.dataset.scrolling
    },
  }
}
