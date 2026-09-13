import { describe, expect, test } from 'bun:test'
import { createDebouncedCallback } from './debounce'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('createDebouncedCallback', () => {
  test('连续调用只在静默后执行一次，并使用最后一次参数', async () => {
    const calls: string[] = []
    const debounced = createDebouncedCallback((value: string) => calls.push(value), 20)

    debounced('a')
    debounced('b')
    debounced('c')

    expect(calls).toEqual([])
    expect(debounced.pending()).toBe(true)

    await sleep(60)

    expect(calls).toEqual(['c'])
    expect(debounced.pending()).toBe(false)
  })

  test('flush 立即执行等待中的调用，并清除定时器不重复触发', async () => {
    const calls: string[] = []
    const debounced = createDebouncedCallback((value: string) => calls.push(value), 1000)

    debounced('立即')
    debounced.flush()

    expect(calls).toEqual(['立即'])
    expect(debounced.pending()).toBe(false)

    // 已无等待调用：再次 flush 不应产生额外执行
    debounced.flush()
    expect(calls).toEqual(['立即'])

    // 定时器已清除：等待一段时间也不会二次触发
    await sleep(30)
    expect(calls).toEqual(['立即'])
  })

  test('cancel 丢弃等待中的调用', async () => {
    const calls: string[] = []
    const debounced = createDebouncedCallback((value: string) => calls.push(value), 20)

    debounced('丢弃')
    expect(debounced.pending()).toBe(true)

    debounced.cancel()
    expect(debounced.pending()).toBe(false)

    await sleep(60)
    expect(calls).toEqual([])

    // cancel 之后仍可重新调用
    debounced('保留')
    await sleep(60)
    expect(calls).toEqual(['保留'])
  })

  test('执行完成后可再次触发（状态不残留）', async () => {
    const calls: number[] = []
    const debounced = createDebouncedCallback((value: number) => calls.push(value), 10)

    debounced(1)
    await sleep(40)
    debounced(2)
    await sleep(40)

    expect(calls).toEqual([1, 2])
  })

  test('不设 maxWait 时持续触发不会执行（纯尾部语义）', async () => {
    const calls: number[] = []
    const debounced = createDebouncedCallback((value: number) => calls.push(value), 30)

    // 每 10ms 触发一次，始终没进入静默期
    for (let i = 0; i < 8; i++) {
      debounced(i)
      await sleep(10)
    }

    expect(calls).toEqual([])
    expect(debounced.pending()).toBe(true)
  })

  test('maxWait：持续触发时至少每 maxWait 执行一次（避免落盘被无限推迟）', async () => {
    const calls: number[] = []
    // wait 30ms、maxWait 60ms；每 10ms 触发一次，永无静默期
    const debounced = createDebouncedCallback((value: number) => calls.push(value), 30, {
      maxWait: 60,
    })

    for (let i = 0; i < 12; i++) {
      debounced(i)
      await sleep(10)
    }

    // 未被无限推迟：至少执行了一次，且取值在递增（证明是“突发中途”执行，而不是等到结束）
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).toBeGreaterThanOrEqual(4)
    const increasing = calls.every((value, index) => index === 0 || value > (calls[index - 1] ?? -1))
    expect(increasing).toBe(true)
  })

  test('maxWait 触发后重新开始计时（不会每帧都执行）', async () => {
    const calls: number[] = []
    const debounced = createDebouncedCallback((value: number) => calls.push(value), 1000, {
      maxWait: 50,
    })

    debounced(1)
    await sleep(120)
    expect(calls).toEqual([1])

    debounced(2)
    await sleep(120)
    expect(calls).toEqual([1, 2])
  })
})
