/**
 * Windows 鼠标滚轮平滑滚动
 *
 * 为什么需要它：Windows 的滚轮是离散输入（一格 = 100px），Chromium 只做固定时长缓动，
 * 既没有 macOS 的速度加速，也没有松手后的惯性衰减，所以同样的内容在 Windows 上「一顿一顿」。
 * 这里接管鼠标滚轮的离散刻度，用临界阻尼弹簧积分出连续位移：
 * 连续转动的刻度会自然叠成一条曲线（不需要「打断 / 重启动画」那套逻辑），
 * 停手后残余速度自然衰减，落点精确、无过冲。
 *
 * 刻意不接管的情况（交还浏览器原生滚动）：
 * - 触控板 / 高精度滚轮的像素级 delta（Windows 精密触控板本身已经连续，接管只会变糊）
 * - Ctrl / Shift / Alt / Meta 组合键（缩放、横向滚动）
 * - 横向为主的滚动、可编辑区域、代码块与 Mermaid 块、标记了 data-smooth-wheel="off" 的容器
 * - prefers-reduced-motion
 *
 * 代价（必须保留关闭开关）：非 passive 的 wheel 监听会让 Chromium 失去合成器线程的快速滚动，
 * 滚动变成主线程串行处理，主线程卡顿时会比原生更明显。
 */

export type WheelGesture = 'tick' | 'pixel'

/** 一格滚轮的典型像素量（Chromium Windows 百分比滚动 100px，部分环境 120px）。 */
const TICK_MIN_PX = 80
/** 行模式下一行折算的像素（与 Chromium 的换算同量级）。 */
const LINE_PX = 40
/** 两个滚轮事件间隔超过该值视为新手势。 */
const GESTURE_IDLE_MS = 180
/** 加速窗口：间隔越小加速越强，超过 BOOST_SLOW_MS 不再加速。 */
const BOOST_FAST_MS = 30
const BOOST_SLOW_MS = 130
const BOOST_MAX = 1.9
/** 临界阻尼弹簧刚度（rad²/s²）：620 → 60fps 下单格约 300ms 落定（更硬会显得顿，更软会发飘）。 */
export const SPRING_STIFFNESS = 620
export const SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS)
/** 每帧物理子步数：60Hz 下每步约 4ms，弹簧积分稳定。 */
const SUBSTEPS = 4
/** 小于该高度的容器不接管：弹出菜单、代码块这类小区域原生滚动已足够，接管只会增加风险。 */
const MIN_SCROLLER_HEIGHT = 120
/** 几何信息缓存时长：流式输出时 scrollHeight 持续变化，但不能每个事件都强制布局。 */
const GEOMETRY_TTL_MS = 100
/** 落定阈值：残差不足 1px 且速度已不可感知时直接贴到目标（肉眼无感，避免 rAF 空转）。 */
const SETTLE_DISTANCE = 0.8
const SETTLE_VELOCITY = 40
const MAX_FRAME_MS = 34

/** 命中这些区域时整段交还原生：编辑区的滚动位置由输入法与光标逻辑掌管，接管只会打架。 */
const NATIVE_ONLY_SELECTOR = 'textarea, input, select, [contenteditable="true"], [data-smooth-wheel="off"]'
/** 横向滚动为主的块：它自己不能被接管，但纵向滚轮应继续交给祖先容器（与浏览器一致）。 */
const SKIP_CANDIDATE_SELECTOR = 'pre, .mermaid-block-scroll'

/** 单帧最大的接管位移，防止异常 delta 把视口甩飞。 */
const MAX_STEP_PX = 900

export interface SpringState {
  position: number
  velocity: number
}

/** 一次滚轮事件的诊断采样（设置页「滚动诊断」与排障使用）。 */
export interface WheelSample {
  at: number
  deltaY: number
  deltaMode: number
  /** 与上一个滚轮事件的间隔（ms） */
  gapMs: number
  /** 本手势的最终判定 */
  gesture: WheelGesture
  /** 是否真正接管（调用了 preventDefault 并驱动弹簧） */
  handled: boolean
  /** 命中的滚动容器摘要；未命中为 null */
  scroller: string | null
  /** 上一段动画的平均帧间隔（ms）；未跑过动画为 null */
  frameMs: number | null
  /** 上一段动画里超过 24ms 的帧数 */
  slowFrames: number
}

export interface SmoothWheelOptions {
  /** 运行时开关；返回 false 时滚轮事件完全不介入。 */
  enabled?: () => boolean
  /** 每次滚轮事件后的诊断采样回调。 */
  onSample?: (sample: WheelSample) => void
  /** 减少动效时直通原生。 */
  reducedMotion?: () => boolean
  now?: () => number
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
}

/** 判定一次滚轮事件属于「离散刻度」还是「像素级连续输入」。 */
export function classifyWheel(deltaMode: number, deltaY: number): WheelGesture {
  // 行 / 页模式本身就是离散语义，只可能来自滚轮刻度。
  if (deltaMode !== 0) return 'tick'
  const magnitude = Math.abs(deltaY)
  if (!Number.isInteger(magnitude)) return 'pixel'
  // Chromium 把 Windows 的一格滚轮换算成 100px（未启用百分比滚动时是 120px），
  // 触控板的像素增量几乎不会稳定停在这个量级；手势中途的形态变化还会再兜一次底。
  return magnitude >= TICK_MIN_PX ? 'tick' : 'pixel'
}

/** 按相邻事件间隔给出加速倍数：转得越快，单格走得越远（复刻 macOS 的速度加速）。 */
export function wheelBoost(gapMs: number): number {
  if (!Number.isFinite(gapMs) || gapMs >= BOOST_SLOW_MS) return 1
  const clamped = Math.min(BOOST_SLOW_MS, Math.max(BOOST_FAST_MS, gapMs))
  return 1 + ((BOOST_SLOW_MS - clamped) / (BOOST_SLOW_MS - BOOST_FAST_MS)) * (BOOST_MAX - 1)
}

/** 一步临界阻尼弹簧积分（dt 单位：秒）。 */
export function stepSpring(state: SpringState, target: number, dtSeconds: number): void {
  const acceleration = SPRING_STIFFNESS * (target - state.position) - SPRING_DAMPING * state.velocity
  state.velocity += acceleration * dtSeconds
  state.position += state.velocity * dtSeconds
}

/** 把滚轮 delta 归一化为像素位移。 */
export function normalizeWheelDelta(deltaMode: number, deltaY: number, viewportHeight: number): number {
  if (deltaMode === 1) return deltaY * LINE_PX
  if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight)
  return deltaY
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

interface Geometry {
  at: number
  max: number
}

interface ActiveScroll {
  element: HTMLElement
  position: number
  velocity: number
  target: number
  max: number
}

function defaultReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * 安装全局滚轮接管，返回卸载函数。
 *
 * 只应在 Windows 上、用户开启平滑滚动时安装：监听器是非 passive 的，
 * 存在就会让滚动失去合成器快速路径，关闭时必须真正移除。
 */
export function installSmoothWheel(options: SmoothWheelOptions = {}): () => void {
  const enabled = options.enabled ?? (() => true)
  const onSample = options.onSample
  const reducedMotion = options.reducedMotion ?? defaultReducedMotion
  const now = options.now ?? (() => performance.now())
  const request = options.requestFrame ?? ((callback) => requestAnimationFrame(callback))
  const cancel = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))

  const geometry = new WeakMap<HTMLElement, Geometry>()
  let active: ActiveScroll | null = null
  let frame: number | null = null
  let lastTick = 0
  let lastEventAt = Number.NEGATIVE_INFINITY
  let lastWritten = 0
  let lastMagnitude = 0
  let gesture: WheelGesture | null = null
  // 上一段动画的帧率统计，用于判断「接管了但主线程跟不上」
  let frameCount = 0
  let frameTotal = 0
  let slowFrames = 0
  let lastFrameMs: number | null = null
  let lastSlowFrames = 0

  function measure(element: HTMLElement, at: number): Geometry {
    const cached = geometry.get(element)
    if (cached && at - cached.at < GEOMETRY_TTL_MS) return cached
    const entry = { at, max: Math.max(0, element.scrollHeight - element.clientHeight) }
    geometry.set(element, entry)
    return entry
  }

  function describe(element: HTMLElement): string {
    const tag = element.tagName.toLowerCase()
    const id = element.id ? `#${element.id}` : ''
    const classes = Array.from(element.classList).slice(0, 2).map((name) => `.${name}`).join('')
    return `${tag}${id}${classes}`
  }

  function write(element: HTMLElement, top: number): void {
    if (element === document.documentElement) {
      window.scrollTo(0, top)
      lastWritten = window.scrollY
      return
    }
    element.scrollTop = top
    lastWritten = element.scrollTop
  }

  function isSmoothScroller(element: Element): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false
    if (element.closest(SKIP_CANDIDATE_SELECTOR)) return false
    if (element.clientHeight < MIN_SCROLLER_HEIGHT) return false
    if (element.scrollHeight - element.clientHeight < 2) return false
    const overflowY = getComputedStyle(element).overflowY
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
  }

  function canScroll(element: HTMLElement, direction: number): boolean {
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    if (max < 2) return false
    // 已经贴边就交给祖先容器，行为与浏览器的滚动链一致。
    return direction > 0 ? element.scrollTop < max - 1 : element.scrollTop > 1
  }

  /** 从事件目标向上找第一个能在该方向继续滚动的容器（含 html 根滚动器）。 */
  function resolveScroller(start: EventTarget | null, direction: number): HTMLElement | null {
    let node: Element | null = start instanceof Element ? start : null
    if (node?.closest(NATIVE_ONLY_SELECTOR)) return null
    while (node) {
      if (isSmoothScroller(node) && canScroll(node, direction)) return node
      node = node.parentElement
    }
    return null
  }

  function stop(): void {
    if (frame !== null) cancel(frame)
    frame = null
    active = null
    if (frameCount > 0) {
      lastFrameMs = frameTotal / frameCount
      lastSlowFrames = slowFrames
    }
    frameCount = 0
    frameTotal = 0
    slowFrames = 0
  }

  /** 结束接管：flush 时把待走的距离一次补齐（换手势时避免丢一格），否则就地停下。 */
  function settle(flush: boolean): void {
    const current = active
    if (current && flush) write(current.element, clamp(current.target, 0, current.max))
    stop()
  }

  function step(timestamp: number): void {
    frame = null
    const current = active
    if (!current) return
    // 容器在动画途中被卸载（切标签、关面板）时直接收手，不再空转。
    if (!current.element.isConnected) {
      stop()
      return
    }
    const rawDt = timestamp - lastTick
    const dt = clamp(rawDt, 1, MAX_FRAME_MS)
    lastTick = timestamp
    frameCount += 1
    frameTotal += rawDt
    if (rawDt > 24) slowFrames += 1
    // 内容可能在动画中途变短（流式输出结束、列表过滤），目标必须跟着夹紧，
    // 否则 target 永远追不到 position，rAF 会空转不停。
    current.target = clamp(current.target, 0, current.max)
    const slice = dt / SUBSTEPS / 1000
    for (let i = 0; i < SUBSTEPS; i += 1) stepSpring(current, current.target, slice)

    if (current.position < 0) {
      current.position = 0
      current.velocity = 0
    } else if (current.position > current.max) {
      current.position = current.max
      current.velocity = 0
    }
    write(current.element, current.position)

    const settled = Math.abs(current.target - current.position) < SETTLE_DISTANCE
      && Math.abs(current.velocity) < SETTLE_VELOCITY
    if (settled) {
      write(current.element, current.target)
      stop()
      return
    }
    frame = request(step)
  }

  function start(): void {
    if (frame !== null) return
    lastTick = now()
    frame = request(step)
  }

  function onWheel(event: WheelEvent): void {
    const at = now()
    const gap = at - lastEventAt
    const sample: WheelSample = {
      at,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      gapMs: gap,
      gesture: 'pixel',
      handled: false,
      scroller: null,
      frameMs: lastFrameMs,
      slowFrames: lastSlowFrames,
    }
    applyWheel(event, at, gap, sample)
    onSample?.(sample)
  }

  function applyWheel(event: WheelEvent, at: number, gap: number, sample: WheelSample): void {
    if (!enabled() || reducedMotion()) return
    if (event.defaultPrevented) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    const rawDelta = event.deltaY
    if (rawDelta === 0 || Math.abs(event.deltaX) > Math.abs(rawDelta)) return

    if (gap > GESTURE_IDLE_MS) {
      gesture = null
      lastMagnitude = 0
    }

    const magnitude = Math.abs(rawDelta)
    const detected = classifyWheel(event.deltaMode, rawDelta)
    if (gesture === null) {
      gesture = detected
    } else if (gesture === 'tick'
      && (detected === 'pixel' || Math.abs(magnitude - lastMagnitude) > 2)) {
      // 同一串手势里 delta 变小或变长：真实设备是触控板 / 高精度滚轮（鼠标刻度是恒定值），
      // 本手势整体交还原生，并把已扣下的位移补齐，避免丢一格。
      gesture = 'pixel'
      settle(true)
    }
    lastEventAt = at
    lastMagnitude = magnitude
    sample.gesture = gesture
    if (gesture === 'pixel') return

    const delta = normalizeWheelDelta(event.deltaMode, rawDelta, window.innerHeight)
    if (!Number.isFinite(delta) || delta === 0) return
    const direction = delta > 0 ? 1 : -1
    const element = resolveScroller(event.target, direction)
    if (!element) return

    event.preventDefault()
    sample.handled = true
    sample.scroller = describe(element)

    const geo = measure(element, at)
    if (!active || active.element !== element) {
      active = { element, position: element.scrollTop, velocity: 0, target: element.scrollTop, max: geo.max }
    }
    const current = active
    current.max = geo.max
    // 动画空闲时用户可能用滚动条 / 键盘挪过位置，以实际位置为准，避免落点漂移。
    if (frame === null && Math.abs(element.scrollTop - current.position) > 1) {
      current.position = element.scrollTop
      current.velocity = 0
      current.target = element.scrollTop
    }

    const increment = clamp(delta * wheelBoost(gap), -MAX_STEP_PX, MAX_STEP_PX)
    current.target = clamp(current.target + increment, 0, geo.max)
    start()
  }

  // 用户一旦用别的方式介入（点滚动条、键盘翻页、触屏），立刻停手，避免和原生滚动抢位置。
  const interrupt = (): void => settle(false)

  /**
   * 动画进行中位置被别人改写（加载历史消息后的位置恢复、锚点修正）时立刻停手：
   * 我们的目标值是绝对位置，继续写会把对方刚恢复的视口拽回去。
   */
  const onScroll = (event: Event): void => {
    if (!active || frame === null) return
    if (event.target !== active.element) return
    if (Math.abs(active.element.scrollTop - lastWritten) > 1) settle(false)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interrupt()
  }

  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  window.addEventListener('pointerdown', interrupt, { passive: true, capture: true })
  window.addEventListener('keydown', onKeyDown, { capture: true })
  window.addEventListener('touchstart', interrupt, { passive: true, capture: true })
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('blur', interrupt)

  return () => {
    window.removeEventListener('wheel', onWheel, { capture: true })
    window.removeEventListener('pointerdown', interrupt, { capture: true })
    window.removeEventListener('keydown', onKeyDown, { capture: true })
    window.removeEventListener('touchstart', interrupt, { capture: true })
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('blur', interrupt)
    stop()
  }
}
