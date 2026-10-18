import { describe, expect, test } from 'bun:test'
import { createSessionUpdateBatcher } from './session-update-batcher'

describe('createSessionUpdateBatcher', () => {
  test('合并同一 session 的一帧更新，但不混合其他 session', () => {
    const callbacks: Array<() => void> = []
    const flushed: Array<[string, readonly string[]]> = []
    const batcher = createSessionUpdateBatcher<string>(
      (sessionId, updates) => flushed.push([sessionId, updates]),
      { schedule: (callback) => { callbacks.push(callback); return callbacks.length }, cancel: () => {} },
    )

    batcher.enqueue('a', 'thinking-1')
    batcher.enqueue('a', 'thinking-2')
    batcher.enqueue('b', 'text-1')
    expect(flushed).toHaveLength(0)

    callbacks[0]!()
    expect(flushed).toEqual([['a', ['thinking-1', 'thinking-2']]])
    callbacks[1]!()
    expect(flushed).toEqual([
      ['a', ['thinking-1', 'thinking-2']],
      ['b', ['text-1']],
    ])
  })

  test('默认调度使用定时器，不依赖 requestAnimationFrame', async () => {
    const flushed: Array<[string, readonly string[]]> = []
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (() => {
      throw new Error('后台窗口不应依赖 requestAnimationFrame')
    }) as typeof requestAnimationFrame

    try {
      const batcher = createSessionUpdateBatcher<string>(
        (sessionId, updates) => flushed.push([sessionId, updates]),
      )
      batcher.enqueue('background-session', 'mobile-message')

      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(flushed).toEqual([['background-session', ['mobile-message']]])
    } finally {
      globalThis.requestAnimationFrame = previousRequestAnimationFrame
    }
  })
  test('flush 会在终态前提交最后一批，cancel 会丢弃过期 session 更新', () => {
    const callbacks: Array<() => void> = []
    const flushed: Array<[string, readonly string[]]> = []
    const batcher = createSessionUpdateBatcher<string>(
      (sessionId, updates) => flushed.push([sessionId, updates]),
      { schedule: (callback) => { callbacks.push(callback); return callbacks.length }, cancel: () => {} },
    )

    batcher.enqueue('a', 'final-delta')
    batcher.flush('a')
    expect(flushed).toEqual([['a', ['final-delta']]])
    callbacks[0]!()
    expect(flushed).toHaveLength(1)

    batcher.enqueue('old', 'stale')
    batcher.cancel('old')
    callbacks[1]!()
    expect(flushed).toHaveLength(1)
  })
})
