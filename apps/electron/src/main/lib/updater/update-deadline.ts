/**
 * 更新流程的超时兜底。
 *
 * 背景：electron-updater 6.8.9 的 `ElectronHttpExecutor` 没有设置任何请求超时，
 * provider 配置里的 `timeout` 字段也不会被任何 provider 读取（已核对
 * `node_modules/electron-updater/out`）。因此只要连接建立后服务端不返回数据
 * （代理半开、CDN 卡住、丢包不回 RST），`checkForUpdates()` 会永远挂起，
 * 既不 resolve 也不 reject。
 *
 * 后果是双重的：界面上的「正在检查」永远不结束；主进程的 in-flight 锁也永远
 * 不释放，之后每次手动检查都会合并进同一个永不结束的 Promise。用户看到的就是
 * 「版本获取无限转圈」。
 *
 * 结论：超时不能交给 electron-updater 配置，必须在我们自己的调用边界上强制截断。
 */

/** 超时类错误单独建模，便于上层把「超时」和「源报错」区分成不同文案。 */
export class UpdateTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(label: string, timeoutMs: number) {
    // 短预算按毫秒表述：测试和现场排障会用 30~500ms 的预算，
    // 四舍五入成「0s」会让人误以为超时没有生效。
    const readable = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`
    super(`${label}超时（${readable}）`)
    this.name = 'UpdateTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * 给任意 promise 加硬截止时间。
 *
 * 注意：这只能保证**调用方**不再被挂住，无法取消底层请求（electron-updater 没有
 * 暴露 abort 入口）。被放弃的请求之后仍可能触发事件，调用方必须自己忽略迟到结果。
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpdateTimeoutError(label, timeoutMs)), timeoutMs)
    // 截止计时器不应拖住主进程退出。
    ;(timer as unknown as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
