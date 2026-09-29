import { afterEach, expect, test } from 'bun:test'
import { initShortcutRegistry, registerShortcut } from './shortcut-registry'

/**
 * 分发层的 handler 执行次数。
 *
 * 这个文件必须能观察到真实的 dispatchShortcut，而 resolveShortcutDispatch 的纯函数
 * 用例（shortcut-registry.test.ts）看不到「注册了几个 handler、执行了几次」。
 * 这里用 query 打破模块缓存，避免与同进程内其它用例共享 registry 状态。
 */

type Listener = (e: unknown) => void

function makeWindow(): { window: unknown; keydown: () => Listener | null } {
  let listener: Listener | null = null
  const window = {
    addEventListener: (type: string, fn: Listener): void => {
      if (type === 'keydown') listener = fn
    },
  }
  return { window, keydown: () => listener }
}

/** 模拟一次 F2 keydown；默认无修饰键、非组合态 */
function pressF2(listener: Listener | null): void {
  listener?.({
    key: 'F2',
    code: 'F2',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  })
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

/**
 * 每个用例用独立模块实例，避免 registry 的模块级 handlers/initialized 串味。
 */
async function freshRegistry(): Promise<{
  register: (id: string, cb: () => void, options?: { exclusive?: boolean }) => () => void
  press: () => void
}> {
  const { window, keydown } = makeWindow()
  ;(globalThis as unknown as { window: unknown }).window = window
  const mod = await import(`./shortcut-registry.ts?probe=${Date.now()}-${Math.random()}`) as {
    initShortcutRegistry: typeof initShortcutRegistry
    registerShortcut: typeof registerShortcut
  }
  mod.initShortcutRegistry()
  return {
    register: (id, cb, options) => mod.registerShortcut(id, cb, options ?? {}),
    press: () => pressF2(keydown()),
  }
}

test('Given 同一快捷键注册多个 handler When 均未声明 exclusive Then 全部执行', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('rename-item', () => { hits++ }))
  cleanup.push(reg.register('rename-item', () => { hits++ }))
  reg.press()
  // 这正是「活跃会话同时渲染在顶部当前会话区与项目列表区」时的原始缺陷形态
  expect(hits).toBe(2)
})

test('Given 同一快捷键注册多个 handler When 均声明 exclusive Then 只执行最后注册的一个', async () => {
  const reg = await freshRegistry()
  const order: number[] = []
  cleanup.push(reg.register('rename-item', () => order.push(1), { exclusive: true }))
  cleanup.push(reg.register('rename-item', () => order.push(2), { exclusive: true }))
  reg.press()
  expect(order).toEqual([2])
})

test('Given 单个 exclusive handler When 触发 Then 正常执行一次', async () => {
  const reg = await freshRegistry()
  let hits = 0
  cleanup.push(reg.register('rename-item', () => { hits++ }, { exclusive: true }))
  reg.press()
  expect(hits).toBe(1)
})

test('Given 有 exclusive 也有非 exclusive When 触发 Then 只跑 exclusive', async () => {
  const reg = await freshRegistry()
  const order: string[] = []
  cleanup.push(reg.register('rename-item', () => order.push('plain')))
  cleanup.push(reg.register('rename-item', () => order.push('exclusive'), { exclusive: true }))
  reg.press()
  expect(order).toEqual(['exclusive'])
})

test('Given 注销后仅剩一个 handler When 触发 Then 不再重复执行', async () => {
  const reg = await freshRegistry()
  let hits = 0
  const off1 = reg.register('rename-item', () => { hits++ }, { exclusive: true })
  cleanup.push(reg.register('rename-item', () => { hits++ }, { exclusive: true }))
  off1()
  reg.press()
  expect(hits).toBe(1)
})
