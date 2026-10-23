import { describe, expect, test } from 'bun:test'
import { attachScrollbarReveal, SCROLLBAR_REVEAL_IDLE_MS } from './scrollbar-reveal'

function setup() {
  const el = { dataset: {} as DOMStringMap } as HTMLElement
  const timers = new Map<number, { callback: () => void; ms: number }>()
  const listeners = new Map<string, (event: unknown) => void>()
  const watch = {
    addEventListener: (name: string, callback: (event: unknown) => void) => { listeners.set(name, callback) },
    removeEventListener: (name: string) => { listeners.delete(name) },
  } as unknown as HTMLElement
  let nextId = 0
  const reveal = attachScrollbarReveal(el, {
    schedule: (callback, ms) => {
      const id = ++nextId
      timers.set(id, { callback, ms })
      return id
    },
    cancel: (id) => { timers.delete(id) },
    watchElement: watch,
  })
  const fire = (id: number): void => {
    const timer = timers.get(id)
    timers.delete(id)
    timer?.callback()
  }
  const emit = (name: string, event: unknown): void => { listeners.get(name)?.(event) }
  return { el, timers, listeners, reveal, fire, emit }
}

describe('attachScrollbarReveal', () => {
  test('滚动时露出，空闲后自动隐藏', () => {
    const { el, timers, reveal, fire } = setup()
    expect(reveal.isVisible()).toBe(false)

    reveal.reveal()
    expect(el.dataset.scrolling).toBe('true')
    expect(reveal.isVisible()).toBe(true)
    expect(timers.size).toBe(1)
    expect([...timers.values()][0]?.ms).toBe(SCROLLBAR_REVEAL_IDLE_MS)

    fire(1)
    expect(el.dataset.scrolling).toBeUndefined()
    expect(reveal.isVisible()).toBe(false)
  })

  test('连续滚动只保留最后一个计时器并顺延隐藏', () => {
    const { el, timers, reveal, fire } = setup()
    reveal.reveal()
    reveal.reveal()
    reveal.reveal()
    expect(timers.size).toBe(1)

    fire(3)
    expect(el.dataset.scrolling).toBeUndefined()
  })

  test('dispose 清理计时器并移除标记', () => {
    const { el, timers, reveal } = setup()
    reveal.reveal()
    reveal.dispose()
    expect(timers.size).toBe(0)
    expect(el.dataset.scrolling).toBeUndefined()
  })

  test('监听滚动容器的滚轮/触摸/翻页键，程序性滚动不触发', () => {
    const { el, reveal, emit } = setup()
    expect(reveal.isVisible()).toBe(false)

    emit('wheel', { target: null })
    expect(reveal.isVisible()).toBe(true)

    reveal.dispose()
    expect(reveal.isVisible()).toBe(false)
  })

  test('dispose 会解绑监听', () => {
    const { listeners, reveal } = setup()
    expect(listeners.size).toBeGreaterThan(0)
    reveal.dispose()
    expect(listeners.size).toBe(0)
  })
})
