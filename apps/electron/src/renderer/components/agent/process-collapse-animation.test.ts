import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { ProcessBlockGroup } from './ProcessBlockGroup'

// 执行真实组件的状态/effect/定时器；不模拟浏览器 layout 或动画绘制。
function harness(reducedMotion = false) {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const keys = ['window', 'requestAnimationFrame', 'cancelAnimationFrame'] as const
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const slots: unknown[] = []
  const effects = new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>()
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let id = 0
  let cursor = 0
  let jobs: Array<() => void> = []
  let measurements = 0
  Object.assign(globalThis, {
    window: {
      matchMedia: () => ({ matches: reducedMotion }),
      setTimeout(callback: () => void, delay: number) { timers.set(++id, { callback, delay }); return id },
      clearTimeout(timer: number) { timers.delete(timer) },
    },
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++id, callback); return id },
    cancelAnimationFrame(frame: number) { frames.delete(frame) },
  })
  const dispatcher = {
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index] as { current: T }
    },
    useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index] as T, value => {
        slots[index] = typeof value === 'function' ? (value as (previous: T) => T)(slots[index] as T) : value
      }]
    },
    useCallback<T>(callback: T): T { return callback },
    useMemo<T>(create: () => T): T { return create() },
    useEffect(create: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++
      const previous = effects.get(index)
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
      jobs.push(() => {
        previous?.cleanup?.()
        effects.set(index, { deps, cleanup: create() || undefined })
      })
    },
  }
  type Content = React.ReactElement<{ style: { height: string }; children?: React.ReactNode }> & {
    ref: React.MutableRefObject<unknown>
  }
  return {
    frames, timers,
    measurements: () => measurements,
    render(streaming = true) {
      cursor = 0
      jobs = []
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      let tree: React.ReactElement
      try {
        tree = ProcessBlockGroup({
          blocks: [], isStreaming: streaming, keepExpandedAfterComplete: false,
          children: React.createElement('span', null, '执行内容'),
        })
      } finally { internals.ReactCurrentDispatcher.current = previous }
      const children = React.Children.toArray(tree.props.children)
      const button = children[0] as React.ReactElement<{ onClick: () => void; 'aria-expanded': boolean }>
      const content = children[1] as Content | undefined
      if (content) content.ref.current = { get scrollHeight() { measurements++; return 800 } }
      jobs.forEach(job => job())
      return { button, content }
    },
    frame() {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(16))
    },
    finishCollapse() {
      for (const [key, timer] of timers) {
        if (timer.delay !== 220) continue
        timers.delete(key)
        timer.callback()
      }
    },
    dispose() {
      effects.forEach(effect => effect.cleanup?.())
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

function run(reduced: boolean, body: (h: ReturnType<typeof harness>) => void) {
  const h = harness(reduced)
  try { body(h) } finally { h.dispose() }
}

describe('执行过程收起动画', () => {
  test('正常收起只测量一次，220ms 后卸载内容', () => run(false, h => {
    h.render().button.props.onClick()
    expect(h.render().button.props['aria-expanded']).toBe(false)
    expect(h.measurements()).toBe(1)
    expect(h.render().content?.props.style.height).toBe('800px')
    h.frame()
    expect(h.render().content?.props.style.height).toBe('0px')
    h.finishCollapse()
    expect(h.render().content).toBeUndefined()
  }))

  test('收起过程中重新展开会取消旧帧和卸载任务', () => run(false, h => {
    h.render().button.props.onClick()
    h.render().button.props.onClick()
    h.render()
    expect(h.frames.size).toBe(0)
    expect(h.timers.size).toBe(0)
    h.finishCollapse()
    expect(h.render().content?.props.style.height).toBe('auto')
    expect(h.render().button.props['aria-expanded']).toBe(true)
  }))

  test('减少动态效果下直接卸载，不测量高度、不排动画帧或等待计时', () => run(true, h => {
    h.render().button.props.onClick()
    h.render()
    expect(h.render().content).toBeUndefined()
    expect(h.measurements()).toBe(0)
    expect(h.frames.size).toBe(0)
    expect(h.timers.size).toBe(0)
  }))
})
