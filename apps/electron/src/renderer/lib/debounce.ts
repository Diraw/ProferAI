/**
 * 尾部触发的防抖原语（trailing-edge debounce），带 flush / cancel / pending / maxWait。
 *
 * 语义对齐成熟实现，不另造概念：
 * - 与 `lodash.debounce(fn, wait, { trailing: true })` 相同的尾部语义：连续调用只在静默
 *   `wait` 毫秒后执行一次，参数取**最后一次调用**；
 * - 与 `lodash.debounce` 相同的 `maxWait`（上限延迟：连续触发期间也保证至少每 `maxWait`
 *   毫秒执行一次，避免“打字不停就一直不落盘”）；
 * - 与 `use-debounce` 的 `useDebouncedCallback` 相同的 `flush()` / `cancel()` 附加方法。
 *
 * 为什么要有共享原语，而不是各处自己写 `setTimeout` + `clearTimeout`：
 * - 手写实现普遍漏掉 flush，导致“组件卸载或切换编辑对象时最后一次输入被丢掉”；
 * - 同时缺少 cancel，卸载后仍可能触发已失效的回调；
 * - 也普遍缺少 maxWait，导致持续输入时落盘被无限推迟。
 *
 * 适用场景（社区/规范共识）：只关心“最终结果”的动作——自动保存、搜索、昂贵重算。
 * **不适用**于需要跟帧的更新（resize / scroll / pointer 驱动的布局与视觉同步）：
 * 那类必须在同一帧处理，最多用 requestAnimationFrame 合并，禁止用时间片防抖，
 * 否则会出现“松手/停止操作后界面才跳一下”的观感。
 */

export interface DebounceOptions {
  /**
   * 最长延迟（ms，lodash `maxWait` 同语义）：连续触发期间最多累积该时长就必须执行一次。
   * 不设置则保持纯尾部语义（只要输入不停就一直不执行）。
   */
  maxWait?: number
}

export interface DebouncedCallback<A extends unknown[]> {
  (...args: A): void
  /** 若存在等待中的调用，立即以最后一次的参数执行，并清除定时器。 */
  flush(): void
  /** 丢弃等待中的调用。 */
  cancel(): void
  /** 是否存在等待中的调用。 */
  pending(): boolean
}

export function createDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
  options: DebounceOptions = {}
): DebouncedCallback<A> {
  const { maxWait } = options
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: A | null = null
  /** 本轮连续触发的起点；执行后重置。 */
  let burstStart: number | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const invoke = (): void => {
    const args = pendingArgs
    pendingArgs = null
    burstStart = null
    clearTimer()
    if (args) fn(...args)
  }

  const debounced = ((...args: A): void => {
    pendingArgs = args
    clearTimer()

    const now = Date.now()
    if (burstStart === null) burstStart = now
    const elapsed = now - burstStart

    if (maxWait !== undefined && elapsed >= maxWait) {
      // 已达最长延迟：本轮不再等待，立即以最新参数执行
      invoke()
      return
    }

    const delay = maxWait === undefined ? wait : Math.min(wait, maxWait - elapsed)
    timer = setTimeout(invoke, delay)
  }) as DebouncedCallback<A>

  debounced.flush = (): void => {
    if (pendingArgs) invoke()
  }
  debounced.cancel = (): void => {
    pendingArgs = null
    burstStart = null
    clearTimer()
  }
  debounced.pending = (): boolean => pendingArgs !== null

  return debounced
}
